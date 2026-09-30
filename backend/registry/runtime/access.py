import hashlib
import hmac
import os
import threading
import time
from http.cookies import SimpleCookie

from .common import RuntimeFailure

CUSTOMER_FEATURES = ["createAgents", "testAgents", "agentTools", "usage"]
FEATURES = [*CUSTOMER_FEATURES, "manageAgents", "tools", "models", "evaluation", "metrics"]
_attempts = {}
_lock = threading.Lock()


def parse_features(value, fallback):
    items = [item.strip() for item in (value or "").split(",") if item.strip()]
    return [] if "none" in items else FEATURES[:] if "all" in items else [item for item in FEATURES if item in items] if items else fallback[:]


def signature(key, issued):
    return hmac.new(key.encode(), f"studio-admin:{issued}".encode(), hashlib.sha256).hexdigest()


def viewer(headers=None):
    headers = headers or {}
    key = os.getenv("STUDIO_ADMIN_KEY")
    admin = not key
    if key:
        try:
            cookies = SimpleCookie()
            cookies.load(headers.get("cookie", ""))
            issued, signed = cookies["studio_admin"].value.split(".")
            admin = 0 <= time.time() * 1000 - int(issued) < 28800000 and hmac.compare_digest(signed, signature(key, issued))
        except (KeyError, ValueError):
            pass
    return {"role": "admin" if admin else "user", "features": parse_features(os.getenv("ADMIN_FEATURES" if admin else "USER_FEATURES"), FEATURES if admin else CUSTOMER_FEATURES),
            "authMode": "key" if key else "open", "allowedModels": None if admin else id_list("CUSTOMER_MODELS"), "allowedTools": None if admin else id_list("CUSTOMER_TOOLS")}


def id_list(name):
    return [item.strip() for item in os.getenv(name, "").split(",") if item.strip()] or None


def require(headers, *features):
    result = viewer(headers)
    if not any(feature in result["features"] for feature in features):
        raise RuntimeFailure("This capability is unavailable for your role. Sign in as an admin.", 403)
    return result


def check_choices(headers, config):
    user = require(headers, "manageAgents", "createAgents")
    if "manageAgents" in user["features"]:
        return
    if config.get("model") and user["allowedModels"] and config["model"] not in user["allowedModels"]:
        raise RuntimeFailure("This model is not available to customers.", 403)
    choices = [config.get("service"), *(config.get("attached_services") or [])]
    if user["allowedTools"] and any(choice and choice not in user["allowedTools"] for choice in choices):
        raise RuntimeFailure("This tool is not available to customers.", 403)


def authenticate(payload, headers):
    if payload.get("action") == "logout":
        return {"body": {"role": "user"}, "cookie": "studio_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"}
    key = os.getenv("STUDIO_ADMIN_KEY")
    if not key:
        raise RuntimeFailure("Admin sign-in is off: STUDIO_ADMIN_KEY is not set.", 400)
    identity, now = headers.get("x-client-address", "unknown"), time.time()
    supplied = payload.get("key")
    if not isinstance(supplied, str) or len(supplied) > 1024:
        raise RuntimeFailure("Invalid admin key.", 400)
    with _lock:
        # Bound memory even when clients change addresses.
        for address in list(_attempts):
            _attempts[address] = [t for t in _attempts[address] if now-t < 60]
            if not _attempts[address]:
                del _attempts[address]
        recent = _attempts.get(identity, [])
        if len(recent) >= 10:
            raise RuntimeFailure("Too many attempts. Try again in a minute.", 429)
        if not hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(key.encode()).digest()):
            _attempts[identity] = [*recent, now]
            raise RuntimeFailure("Incorrect admin key.", 401)
        _attempts.pop(identity, None)
    issued = str(int(now * 1000))
    return {"body": {"role": "admin"}, "cookie": f"studio_admin={issued}.{signature(key, issued)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800"}


def visible_metrics(headers, result):
    user = require(headers, "metrics", "usage")
    if "metrics" in user["features"]:
        return result
    return {"window": result.get("window"), "summary": {k: result.get("summary", {}).get(k) for k in ("questions", "conversations", "activeAgents", "up", "down", "helpfulRate")},
            "business": {"topQuestions": result.get("business", {}).get("topQuestions", [])},
            "recent": [{k: row.get(k) for k in ("id", "createdAt", "agentName", "question", "feedback")} for row in result.get("recent", [])]}
