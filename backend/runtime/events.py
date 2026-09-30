"""Saved-change monitoring and read-only, transient draft checks."""
import hashlib
import hmac
import json
import logging
import os
import queue
import re
import threading
from uuid import uuid4

from django.db import close_old_connections
from template import services
from runtime.common import RuntimeFailure, now_iso, numeric, redis_client
from runtime.execution import record
from agents.anomaly_detection.agent import AnomalyDetectionAgent
from runtime.payroll import load_context

logger = logging.getLogger(__name__)
STREAM, GROUP, CHANNEL = "payroll:events", "realtime-monitor", "payroll:checks"
_listeners = set()
_listeners_lock = threading.Lock()
_queue = queue.Queue(maxsize=1000)
_stop = threading.Event()


def validate_event(body):
    if not isinstance(body, dict) or body.get("type") != "payrun.changed":
        raise RuntimeFailure('type must be "payrun.changed".', 400)
    for key in ("payrunId", "lineId", "employeeId"):
        value = body.get(key)
        if (key == "payrunId" or value is not None) and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", value)):
            raise RuntimeFailure(f"{key} is invalid.", 400)
    version = body.get("version")
    if version is not None and (not numeric(version) or int(version) != version or version <= 0):
        raise RuntimeFailure("version must be a positive integer.", 400)
    return {key: body.get(key) for key in ("type", "payrunId", "version", "lineId", "employeeId", "changedAt")}


def publish(body, headers):
    expected = os.getenv("PAYROLL_EVENTS_TOKEN")
    if expected and not hmac.compare_digest(hashlib.sha256(expected.encode()).digest(), hashlib.sha256(headers.get("x-payroll-events-token", "").encode()).digest()):
        raise RuntimeFailure("Invalid payroll event token.", 401)
    event = validate_event(body)
    try:
        if os.getenv("REDIS_URL"):
            redis_client().xadd(STREAM, {"event": json.dumps(event)}, maxlen=10000, approximate=True)
        else:
            _queue.put_nowait(event)
    except Exception as error:
        raise RuntimeFailure("Payroll event storage is unavailable. Retry this event.") from error
    return {"accepted": True}


def preview(body, *, load=load_context):
    return AnomalyDetectionAgent.preview(body, load=load)


def broadcast(result):
    if os.getenv("REDIS_URL"):
        redis_client().publish(CHANNEL, json.dumps(result))
    else:
        with _listeners_lock:
            for listener in _listeners:
                try:
                    listener.put_nowait(result)
                except queue.Full:
                    pass


def process(event):
    context = load_context(event)
    for domain in services.list_domains():
        name = domain["name"]
        monitors = services.get_service_agent_registry("", name)
        for definition in monitors:
            if definition["template_id"] != "anomaly-detection" or not definition["config"].get("capabilities", {}).get("alerts", {}).get("enabled"):
                continue
            agent = AnomalyDetectionAgent({**definition, "domain_name": name})
            result = agent.on_change(event, context)
            broadcast(result)
            record(name, definition, "Real-time payroll change check", event,
                   {"reply": result["anomaly"]["summary"], "answeredBy": "anomaly-detection"}, 0, "realtime-monitor", context)


def watch(filters, active):
    domain, payrun = filters.get("domainName"), filters.get("payrunId")
    if not domain or not payrun:
        raise RuntimeFailure("A domain and payrun are required.", 400)
    services.get_domain(domain)
    listener = queue.Queue(maxsize=100)
    subscriber = redis_client().pubsub() if os.getenv("REDIS_URL") else None
    if subscriber:
        subscriber.subscribe(CHANNEL)
    else:
        with _listeners_lock:
            _listeners.add(listener)
    try:
        while active():
            if subscriber:
                message = subscriber.get_message(ignore_subscribe_messages=True, timeout=10)
                result = json.loads(message["data"]) if message else None
            else:
                try:
                    result = listener.get(timeout=10)
                except queue.Empty:
                    result = None
            if result is None:
                yield {"type": "heartbeat"}
            elif result.get("domainName") == domain and result.get("payrunId") == payrun:
                yield result
    finally:
        if subscriber:
            subscriber.close()
        with _listeners_lock:
            _listeners.discard(listener)


def start_monitor():
    _stop.clear()

    def loop():
        consumer = uuid4().hex
        while not _stop.is_set():
            close_old_connections()
            try:
                if os.getenv("REDIS_URL"):
                    client = redis_client()
                    try:
                        client.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
                    except Exception as error:
                        if "BUSYGROUP" not in str(error):
                            raise
                    pending = client.xautoclaim(STREAM, GROUP, consumer, min_idle_time=60000, start_id="0-0", count=10)[1]
                    batches = [(STREAM, pending)] if pending else client.xreadgroup(GROUP, consumer, {STREAM: ">"}, count=10, block=5000)
                    for _, entries in batches:
                        for identity, entry in entries:
                            process(json.loads(entry["event"]))
                            client.xack(STREAM, GROUP, identity)
                else:
                    try:
                        event = _queue.get(timeout=5)
                    except queue.Empty:
                        continue
                    try:
                        process(event)
                    except Exception:
                        _queue.put_nowait(event)
                        raise
            except Exception:
                logger.warning("Payroll monitor could not process a change; it will retry.")
                _stop.wait(5)
            finally:
                close_old_connections()
    thread = threading.Thread(target=loop, name="payroll-monitor", daemon=True)
    thread.start()
    return _stop
