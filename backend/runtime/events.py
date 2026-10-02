"""API read/save monitoring and read-only, transient draft checks."""
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
    if isinstance(body, dict) and body.get("type") == "anomaly.recorded":
        from agents.anomaly_detection.records import validate_record_event
        return validate_record_event(body)
    if not isinstance(body, dict) or body.get("type") not in ("payrun.changed", "payrun.loaded", "paycheck.opened"):
        raise RuntimeFailure('type must be "payrun.changed", "payrun.loaded", or "paycheck.opened".', 400)
    for key in ("payrunId", "lineId", "employeeId"):
        value = body.get(key)
        if (key == "payrunId" or value is not None) and (not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", value)):
            raise RuntimeFailure(f"{key} is invalid.", 400)
    version = body.get("version")
    if version is not None and (not numeric(version) or int(version) != version or version <= 0):
        raise RuntimeFailure("version must be a positive integer.", 400)
    if body["type"] in ("payrun.loaded", "paycheck.opened"):
        if not isinstance(body.get("domainName"), str) or not re.fullmatch(r"[A-Za-z0-9._-]{1,100}", body["domainName"]):
            raise RuntimeFailure("A valid monitoring domain is required.", 400)
        if version is None or (body["type"] == "paycheck.opened" and (not body.get("lineId") or not body.get("employeeId"))):
            raise RuntimeFailure("Read events require a version and paycheck events require a line and employee.", 400)
    return {key: body.get(key) for key in ("type", "payrunId", "version", "lineId", "employeeId", "changedAt", "domainName")}


def publish(body, headers):
    expected = os.getenv("PAYROLL_EVENTS_TOKEN")
    if expected and not hmac.compare_digest(hashlib.sha256(expected.encode()).digest(), hashlib.sha256(headers.get("x-payroll-events-token", "").encode()).digest()):
        raise RuntimeFailure("Invalid payroll event token.", 401)
    event = validate_event(body)
    if event["type"] == "anomaly.recorded":
        from agents.anomaly_detection.streaming import accept
        return accept(event)
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
    from agents.anomaly_detection.components import PROFILES, is_anomaly_agent
    historical, incremental = [], set()
    for domain in services.list_domains():
        name = domain["name"]
        if event.get("domainName") and event["domainName"] != name:
            continue
        monitors = services.get_service_agent_registry("", name)
        for definition in monitors:
            if not is_anomaly_agent(definition) or not definition["config"].get("capabilities", {}).get("alerts", {}).get("enabled"):
                continue
            profile = definition["config"].get("anomaly", {}).get("profile", "payroll")
            if profile in PROFILES and PROFILES[profile].event_type == "anomaly.recorded" and definition["config"].get("domain") == "Payroll":
                incremental.add(name)
            elif profile == "payroll":
                historical.append((name, definition))
    context = load_context(event) if historical else None
    def verify_version(current):
        if event.get("version") and current.get("version", 0) < event["version"]:
            raise RuntimeFailure("The payroll API has not exposed the triggered version yet. Retry this check.")
    if context is not None:
        verify_version(context["current"])
    if incremental:
        from runtime.payroll import load_current
        from agents.anomaly_detection.domains.payroll_records import payrun_events
        from agents.anomaly_detection.streaming import accept
        current = context["current"] if context is not None else load_current(event)
        verify_version(current)
        if event.get("type") == "paycheck.opened":
            current = {**current, "lines": [line for line in current["lines"] if line["employeeId"] == event["employeeId"]]}
        for name in sorted(incremental):
            for normalized in payrun_events(current, name):
                accept(normalized)
    for name, definition in historical:
        agent = AnomalyDetectionAgent({**definition, "domain_name": name})
        if event.get("type"):
            broadcast({"type": "scanning", "domainName": name, "payrunId": event["payrunId"],
                       "version": context["current"]["version"], "monitor": {"id": definition["id"], "name": definition["name"]}})
        result = agent.on_change(event, context)
        broadcast(result)
        record(name, definition, "Real-time payroll change check", event,
               {"reply": result["anomaly"]["summary"], "answeredBy": "anomaly-detection"}, 0, "realtime-monitor", context)


def watch(filters, active):
    domain, payrun = filters.get("domainName"), filters.get("entityId", filters.get("payrunId"))
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
            elif (result.get("domainName") == domain and result.get("entityId", result.get("payrunId")) == payrun
                  and (not filters.get("entityType") or result.get("entityType") == filters["entityType"])
                  and (not result.get("tenant") or (result.get("tenant") == filters.get("tenant") and result.get("entityType") == filters.get("entityType")))):
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
                from agents.anomaly_detection.streaming import drain_pending
                drain_pending(broadcast=broadcast)
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
