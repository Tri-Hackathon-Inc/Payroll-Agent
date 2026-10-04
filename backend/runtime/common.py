import hashlib
import json
import math
import os
from datetime import date, datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from urllib.request import Request, build_opener

from model.runtime import NoRedirects


class RuntimeFailure(Exception):
    def __init__(self, message, status=503):
        super().__init__(message)
        self.status = status


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def rounded(value):
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def cents(value):
    return int(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP) * 100)


def numeric(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and abs(value) < 1e10


def valid_date(value):
    try:
        return isinstance(value, str) and len(value) == 10 and date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def at(value, path):
    for key in path.split("."):
        value = value.get(key) if isinstance(value, dict) else None
    return value


def total(lines, paths):
    values = [at(line, path) for line in lines for path in paths]
    return sum(cents(v) for v in values) / 100 if values and all(numeric(v) for v in values) else None


def request_json(url, payload, timeout=15, headers=None, json_response=True):
    request = Request(url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json", **(headers or {})}, method="POST")
    try:
        with build_opener(NoRedirects()).open(request, timeout=timeout) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError("Response too large")
        return json.loads(raw) if json_response else None
    except Exception as error:
        raise RuntimeFailure("The configured backend service is unavailable.") from error


def redis_client():
    import redis
    url = os.getenv("REDIS_URL")
    if not url:
        raise RuntimeFailure("Conversation and event storage is unavailable. Configure Redis and retry.")
    return redis.Redis.from_url(url, decode_responses=True, socket_timeout=10, socket_connect_timeout=5)
