"""Versioned, domain-neutral event contract for payroll, leave, benefits or claims."""
from copy import deepcopy
from datetime import datetime, timezone
import math
import re

from runtime.common import RuntimeFailure, digest


def identifier(value, label, maximum=100):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1," + str(maximum) + "}", value):
        raise RuntimeFailure(f"{label} must be a stable identifier (at most {maximum} characters).", 400)
    return value


def validate_record_event(body):
    if not isinstance(body, dict) or body.get("type") != "anomaly.recorded":
        raise RuntimeFailure('type must be "anomaly.recorded".', 400)
    allowed = {"type", "domainName", "tenant", "entityType", "entityId", "version", "occurredAt", "finalized", "measurements"}
    if set(body) != allowed:
        raise RuntimeFailure("Supply exactly the documented anomaly event fields.", 400)
    event = deepcopy(body)
    for key in ("domainName", "tenant", "entityType", "entityId"):
        identifier(event.get(key), key, 60 if key == "entityType" else 100)
    version = event.get("version")
    if isinstance(version, bool) or not isinstance(version, (int, float)) or not 0 < version <= 2**53 - 1 or not math.isfinite(version) or int(version) != version:
        raise RuntimeFailure("version must be a positive safe integer.", 400)
    event["version"] = int(version)
    try:
        instant = datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00"))
        if instant.tzinfo is None:
            raise ValueError("Missing timezone")
        event["occurredAt"] = instant.astimezone(timezone.utc).isoformat(timespec="microseconds")
    except (ValueError, TypeError, AttributeError, OverflowError):
        raise RuntimeFailure("occurredAt must be an ISO timestamp with a timezone.", 400) from None
    if not isinstance(event["finalized"], bool):
        raise RuntimeFailure("finalized must be true or false.", 400)
    measurements = event["measurements"]
    if not isinstance(measurements, list) or not 1 <= len(measurements) <= 30:
        raise RuntimeFailure("Supply 1 to 30 measurements per record.", 400)
    seen = set()
    for item in measurements:
        if not isinstance(item, dict) or set(item) != {"name", "value", "unit", "dimensions"}:
            raise RuntimeFailure("Each measurement needs name, value, unit and dimensions.", 400)
        identifier(item["name"], "measurement name", 60)
        identifier(item["unit"], "measurement unit", 30)
        value = item["value"]
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or abs(value) > 1e15 or not math.isfinite(value)):
            raise RuntimeFailure("Measurements must be finite numbers within +/- 1e15, or null for missing data.", 400)
        dimensions = item["dimensions"]
        if not isinstance(dimensions, dict) or len(dimensions) > 8:
            raise RuntimeFailure("Supply at most eight measurement dimensions.", 400)
        for key, dimension in dimensions.items():
            identifier(key, "dimension name", 60)
            identifier(dimension, "dimension value")
        key = feature_key(event, item)
        if key in seen:
            raise RuntimeFailure("A record cannot repeat the same measurement and dimensions.", 400)
        seen.add(key)
    return event


def source_key(event):
    return digest([event["domainName"], event["tenant"], event["entityType"], event["entityId"]])


def feature_key(event, measurement):
    return digest(["rolling-v1", event["domainName"], event["tenant"], event["entityType"],
                   measurement["name"], measurement["unit"], measurement["dimensions"]])
