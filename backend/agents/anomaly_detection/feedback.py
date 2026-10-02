"""Append-only human decisions; feedback never changes source data or calls a model."""
import hashlib
import re
from uuid import UUID
from django.db import transaction
from runtime.common import RuntimeFailure
from .models import AnomalyCase, AnomalyAudit


def record_feedback(agent, body, headers):
    if not isinstance(body.get("anomalyId"), str) or not re.fullmatch(r"[a-f0-9]{64}", body["anomalyId"]):
        raise RuntimeFailure("A valid anomaly ID is required.", 400)
    action, note = body.get("action"), body.get("note", "")
    if action not in ("CONFIRMED", "DISMISSED") or not isinstance(note, str) or len(note) > 2000:
        raise RuntimeFailure("Feedback requires CONFIRMED or DISMISSED and a note of at most 2,000 characters.", 400)
    try:
        request_id = UUID(str(body.get("requestId")))
    except (ValueError, TypeError):
        raise RuntimeFailure("Feedback requires a UUID requestId.", 400) from None
    reviewer = hashlib.sha256(headers["x-session-owner"].encode()).hexdigest()
    with transaction.atomic():
        case = AnomalyCase.objects.select_for_update().filter(pk=body.get("anomalyId"),
            domain_id=agent.definition["domain_name"], agent_id=agent.definition["id"]).first()
        if case is None:
            raise RuntimeFailure("Anomaly not found for this agent and domain.", 404)
        if isinstance(body.get("expectedVersion"), bool) or body.get("expectedVersion") != case.payrun_version:
            raise RuntimeFailure("Feedback refers to a different source version.", 409)
        if action == "CONFIRMED" and case.review_status != "completed":
            raise RuntimeFailure("Complete the investigation before recording feedback.", 409)
        if action == "DISMISSED" and case.review_status == "investigating":
            raise RuntimeFailure("Wait for the current investigation before dismissing this finding.", 409)
        if action == "DISMISSED" and case.review_status != "completed" and not note.strip():
            raise RuntimeFailure("Explain why these payments are expected before dismissing the review.", 400)
        row, created = AnomalyAudit.objects.get_or_create(case=case, request_id=request_id,
            defaults={"action": action, "reviewer_hash": reviewer, "details": {"note": note.strip()}})
        if not created and (row.action != action or row.reviewer_hash != reviewer or row.details != {"note": note.strip()}):
            raise RuntimeFailure("This feedback requestId was already used for a different decision.", 409)
    from .agent import case_data
    return case_data(case)
