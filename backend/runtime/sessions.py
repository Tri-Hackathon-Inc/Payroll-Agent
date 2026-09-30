import json
import os
import re
import secrets

from runtime.common import RuntimeFailure, digest, now_iso, redis_client

RELEASE = 'if redis.call("GET",KEYS[1]) == ARGV[1] then return redis.call("DEL",KEYS[1]) else return 0 end'
SAVE = 'if redis.call("GET",KEYS[1]) ~= ARGV[1] then return 0 end redis.call("SET",KEYS[2],ARGV[2],"EX",ARGV[3]) return 1'


def validate_history(history):
    if not isinstance(history, list) or len(history) > 40 or len(history) % 2 or len(json.dumps(history)) > 100000:
        raise RuntimeFailure("Conversation history must contain at most 20 complete user and assistant turns.", 400)
    for index, item in enumerate(history):
        if (not isinstance(item, dict) or set(item) != {"role", "content"} or item.get("role") != ("assistant" if index % 2 else "user")
                or not isinstance(item.get("content"), str) or not item["content"].strip() or len(item["content"]) > 10000):
            raise RuntimeFailure("Conversation history must contain alternating user and assistant text messages.", 400)


def with_conversation(options, execute, client=None):
    question = options.get("question")
    if not isinstance(question, str) or not question.strip() or len(question) > 10000:
        raise RuntimeFailure("A question of at most 10,000 characters is required.", 400)
    context = options.get("context", {})
    if not isinstance(context, dict):
        raise RuntimeFailure("Conversation context must be an object.", 400)
    context = {k: v for k, v in context.items() if k in ("page", "payrunId", "employeeId")}
    if any(v is not None and (not isinstance(v, str) or not v.strip() or len(v) > 255) for v in context.values()):
        raise RuntimeFailure("Invalid conversation context.", 400)
    history = options.get("history") or []
    validate_history(history)
    session_id, request_id = options.get("sessionId"), options.get("requestId")
    if session_id and (not isinstance(session_id, str) or not re.fullmatch(r"[a-f0-9]{64}", session_id)):
        raise RuntimeFailure("Invalid conversation session.", 400)
    if request_id and (not isinstance(request_id, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,80}", request_id)):
        raise RuntimeFailure("Invalid request ID.", 400)
    if client is None and not os.getenv("REDIS_URL"):
        if session_id or context.get("payrunId"):
            raise RuntimeFailure("Question confirmation requires conversation storage. Configure Redis and retry.")
        result = execute({"history": history, "context": context, "focus": None})
        return {**result["answer"], "session": {"id": None, "status": "disabled", "expiresInSeconds": 0}}
    client = client or redis_client()
    identity = session_id or secrets.token_hex(32)
    # Separate serialization version: existing JS sessions expire without being misinterpreted.
    key, token = "payroll:session:py:" + identity, secrets.token_hex(16)
    lock = key + ":lock"
    scope_hash = digest(options["scope"])
    request_hash = digest({"question": question, "context": context, "confirmation": options.get("confirmation")})
    ttl = max(60, min(int(os.getenv("CHAT_SESSION_TTL_SECONDS", "1800")), 86400))
    try:
        if not client.set(lock, token, nx=True, px=300000):
            raise RuntimeFailure("A response is already being prepared in this conversation. Retry shortly.", 409)
        try:
            stored = client.get(key)
            if session_id and not stored:
                raise RuntimeFailure("This conversation has expired. Start a new chat.", 410)
            state = json.loads(stored) if stored else {"scopeHash": scope_hash, "context": context, "history": history, "focus": None}
            if state["scopeHash"] != scope_hash:
                raise RuntimeFailure("This conversation belongs to a different agent or browser. Start a new chat.", 409)
            if stored and any(state["context"].get(k) != v for k, v in context.items()):
                raise RuntimeFailure("The payrun or employee selection changed. Start a new chat for this selection.", 409)
            last = state.get("lastRequest") or {}
            if request_id and last.get("id") == request_id:
                if last["hash"] != request_hash:
                    raise RuntimeFailure("A request ID cannot be reused for a different question.", 409)
                client.expire(key, ttl)
                answer = last["answer"]
            else:
                result = execute(state)
                answer = result["answer"]
                content = answer.get("reply", answer.get("output"))
                if not isinstance(content, str):
                    raise RuntimeFailure("The model did not return a conversation response.")
                turns = list(state["history"])
                if result.get("recordTurn", True):
                    turns += [{"role": "user", "content": question.strip()}, {"role": "assistant", "content": content}]
                turns = turns[-40:]
                while len(turns) > 2 and len(json.dumps(turns)) > 60000:
                    turns = turns[2:]
                state.update(history=turns, focus=result.get("focus", state.get("focus")), pendingQuestion=result.get("pendingQuestion"), updatedAt=now_iso(), lastRequest={"id": request_id, "hash": request_hash, "answer": answer})
                if not client.eval(SAVE, 2, lock, key, token, json.dumps(state), str(ttl)):
                    raise RuntimeFailure("The conversation took too long to save. Retry your question.", 409)
            return {**answer, "session": {"id": identity, "status": "active", "expiresInSeconds": ttl}}
        finally:
            try:
                client.eval(RELEASE, 1, lock, token)
            except Exception:
                pass
    except RuntimeFailure:
        raise
    except Exception as error:
        raise RuntimeFailure("Conversation storage is unavailable. Try again.") from error
