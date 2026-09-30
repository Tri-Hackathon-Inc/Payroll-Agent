import json
import math
import re
import time
from pathlib import Path
from uuid import uuid4

from pipelines.config import pipeline_settings
from runtime.common import RuntimeFailure, digest
from runtime.retrieval import LocalEmbeddings, VectorStore

LIBRARY = json.loads(Path(__file__).with_name("payroll_questions.json").read_text(encoding="utf-8"))


def catalogue(agent, domain_name):
    config = agent["config"]
    scope = digest(["questions-v2", domain_name, agent["id"], config.get("service")])
    texts = list(config.get("questions", []))
    if pipeline_settings(config)["query"]["includeSharedQuestions"]:
        texts += [question for group in LIBRARY for question in group["questions"]]
    result = {}
    for text in texts:
        if isinstance(text, str) and text.strip() and len(text) <= 2000:
            normalized = " ".join(text.split())
            key = normalized.lower()
            result.setdefault(key, {"id": digest([scope, key]), "scope": scope, "text": normalized})
    return list(result.values())


def question_flow(agent, domain_name, question, confirmation, conversation, answer_question, store=None, now=None):
    if not conversation.get("scopeHash"):
        raise RuntimeFailure("Question confirmation requires conversation storage. Configure Redis and retry.")
    settings = pipeline_settings(agent["config"])["query"]
    questions = catalogue(agent, domain_name)
    revision = digest([questions, agent["config"]])
    now = time.time() * 1000 if now is None else now
    if confirmation is not None:
        if not isinstance(confirmation, dict) or not all(isinstance(confirmation.get(k), str) for k in ("mappingId", "questionId")):
            raise RuntimeFailure("Confirm a proposed question using its mappingId and questionId.", 400)
        pending = conversation.get("pendingQuestion")
        if not pending or confirmation["mappingId"] != pending["id"] or pending["expiresAt"] <= now or pending["originalQuery"] != question.strip() or pending["revision"] != revision:
            raise RuntimeFailure("This question match has expired or changed. Submit the query again to review a new match.", 409)
        match = next((item for item in pending["candidates"] if item["id"] == confirmation["questionId"]), None)
        if not match or not any(item["id"] == match["id"] and item["text"] == match["text"] for item in questions):
            raise RuntimeFailure("Choose one of the questions proposed for this query.", 400)
        mapped = {**match, "originalQuery": question.strip()}
        answer = answer_question(mapped)
        focus = answer.pop("focus", conversation.get("focus"))
        return {"answer": {**answer, "status": "answered", "mappedQuestion": mapped}, "focus": focus, "pendingQuestion": None}
    previous = conversation.get("focus")
    query = question.strip()
    if previous and re.match(r"(and\b|what about\b|how about\b|why\b|explain\b)", query, re.I):
        query += f"\nPrior question: {previous.get('question', '')}. Topics: {', '.join(previous.get('topics', []))}."
    try:
        matches = (store or VectorStore("questions")).search(questions, query, settings["candidateLimit"])
    except Exception as error:
        raise RuntimeFailure("Predefined-question search is unavailable. Please retry; no payroll retrieval or model call has run.") from error
    trusted = {item["id"]: item for item in questions}
    candidates = [{"id": item["id"], "text": trusted[item["id"]]["text"], "distance": item["distance"]} for item in matches if item.get("id") in trusted and isinstance(item.get("distance"), (int, float)) and math.isfinite(item["distance"])]
    if not candidates:
        raise RuntimeFailure("No predefined question could be matched. Rephrase the query or update the agent questions.")
    pending = {"id": str(uuid4()), "originalQuery": question.strip(), "candidates": candidates, "revision": revision, "expiresAt": now + settings["confirmationTtlSeconds"] * 1000}
    return {"recordTurn": False, "pendingQuestion": pending, "answer": {"status": "confirmation_required", "answeredBy": "question-mapping",
            "reply": "Confirm the predefined question you want this agent to answer.", "questionMapping": {k: v for k, v in pending.items() if k != "revision"} | {"embeddingModel": LocalEmbeddings.version}, "model": None, "metrics": None}}
