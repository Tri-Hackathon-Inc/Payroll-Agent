"""Saved-change monitoring and read-only, transient draft checks."""
import hashlib
import hmac
import json
import logging
import os
import queue
import re
import threading
from copy import deepcopy
from uuid import uuid4

from django.db import close_old_connections
from registry import services
from .common import RuntimeFailure, now_iso, numeric, redis_client
from .execution import record
from .incidents import brief, raise_incidents, signals
from .finding_policy import detect_signals
from .payroll import load_context, preprocess

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
    if not isinstance(body, dict) or not all(isinstance(body.get(k), str) and body[k] for k in ("payrunId", "lineId")):
        raise RuntimeFailure("A payrun and payment line are required.", 400)
    context = deepcopy(load(body))
    current = context["current"]
    if current["status"] != "PENDING_APPROVAL":
        raise RuntimeFailure("Completed payroll cannot be edited.", 409)
    if body.get("expectedVersion") != current.get("version"):
        raise RuntimeFailure("This payroll has changed. Reload it before checking edits.", 409)
    line = next((line for line in current["lines"] if line.get("lineId") == body["lineId"]), None)
    if not line:
        raise RuntimeFailure("The payment line is not in this payrun.", 404)
    changes = body.get("changes")
    allowed = {"hours": {"regular", "overtime"}, "earnings": {"bonus", "reimbursement"}, "deductions": {"health", "garnishment"}, "paymentMethod": None}
    if not isinstance(changes, dict) or not changes or set(changes) - set(allowed):
        raise RuntimeFailure("Supply editable payroll fields only.", 400)
    derived_pending = False
    for group, values in changes.items():
        if group == "paymentMethod":
            if values not in ("Direct Deposit", "Live Check"):
                raise RuntimeFailure("Invalid payment method.", 400)
            line[group] = values
            continue
        if not isinstance(values, dict) or not values or set(values) - allowed[group]:
            raise RuntimeFailure("Invalid draft payroll fields.", 400)
        if group == "hours" and line.get("payType") != "hourly":
            raise RuntimeFailure("Hours cannot be edited on a salaried payment.", 400)
        for key, value in values.items():
            maximum = 200 if group == "hours" else 1000000
            if not numeric(value) or not 0 <= value <= maximum:
                raise RuntimeFailure(f"Enter a valid {group}.{key} from 0 to {maximum}.", 400)
            line[group][key] = value
        derived_pending = True
    if derived_pending:
        # Payroll owns tax/retirement calculations. Never compare stale totals as if
        # they had already been recalculated for a draft input.
        line["gross"] = line["net"] = None
        line["deductions"]["retirement401k"] = None
    evidence = preprocess(current, context["history"], line["employeeId"])
    return {"type": "preview", "saved": False, "payrunId": current["id"], "version": current["version"], "lineId": line["lineId"], "employeeId": line["employeeId"],
            "checkedAt": now_iso(), "analysis": evidence, "findings": [brief(item) for item in signals(evidence)], "derivedAmountsPending": derived_pending}


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
    evidence = preprocess(context["current"], context["history"])
    findings = detect_signals(context["current"], context["history"])
    incident_failure = False
    for domain in services.list_domains():
        name = domain["name"]
        agents = services.get_service_agent_registry("", name)
        monitor = next((agent for agent in agents if agent["template_id"] == "anomaly-detection" and agent["config"].get("capabilities", {}).get("alerts", {}).get("enabled")), None)
        if not monitor:
            continue
        try:
            alert = raise_incidents(monitor, agents, name, context, evidence) or {}
        except Exception:
            incident_failure = True
            alert = {"raised": None, "suggested": [], "alreadyRaised": 0, "note": "Incident processing is unavailable and will retry. Calculated findings remain available."}
        employee = next((item for item in evidence["employees"] if item["employeeId"] == event.get("employeeId")), None)
        result = {"type": "incident" if alert.get("raised") else "checked", "domainName": name, "payrunId": event["payrunId"], "version": context["current"].get("version"),
                  "checkedAt": now_iso(), "monitor": {"id": monitor["id"], "name": monitor["name"]}, "reason": "a saved payroll change", "analysis": evidence,
                  "findings": [brief(item) for item in findings], "critical": sum(item["severity"] == "critical" for item in findings),
                  "changedEmployee": {"employeeId": employee["employeeId"], "name": employee["name"], "findings": [brief(item) for item in findings if item["employeeId"] == employee["employeeId"]]} if employee else None,
                  **alert}
        broadcast(result)
        record(name, monitor, "Real-time payroll change check", event, {"reply": "Payroll checked.", "answeredBy": "anomaly-pipeline", "incidentAlert": alert}, 0, "realtime-monitor", context)
    if incident_failure:
        raise RuntimeFailure("Incident processing is unavailable; retry the saved change.")


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
