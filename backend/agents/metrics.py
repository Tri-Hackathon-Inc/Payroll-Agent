"""Agent interaction metrics for the admin view: recording, feedback, and aggregation.

Every answered question is recorded (see runtime/execution.py). Metrics are measured values only:
counts, latency, tokens, reply checks, findings, incidents, and user feedback; nothing is
estimated. Benchmark runs are recorded but excluded from the metrics.
"""

import math
from collections import Counter, defaultdict
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from uuid import UUID

from django.db import transaction
from django.utils import timezone

from storage.models import Agent, AgentInteraction
from template.services import InvalidInput, NotFound, get_domain

ANSWER_TYPES = ("payroll-data", "model", "rag", "anomaly-pipeline", "anomaly-detection",
                "anomaly-investigation", "incident-report", "clarification", "acknowledged", "error")
CHECK_STATUSES = ("", "passed", "flagged")
SEVERITIES = ("critical", "warning", "info")
RATINGS = ("up", "down", "")
MAX_ROWS = 5000
REALTIME = "realtime-monitor"
RECENT = 12
TOP_QUESTIONS = 8


def _uuid(value, label):
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        raise InvalidInput(f"{label} must be a UUID.") from None


def _text(data, key, limit, required=False):
    value = data.get(key, "")
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise InvalidInput(f"{key} must be text.")
    value = value.strip()
    if required and not value:
        raise InvalidInput(f"{key} is required.")
    return value[:limit]


def _count(data, key, nullable=False):
    value = data.get(key)
    if value is None:
        if nullable:
            return None
        return 0
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or not math.isfinite(value):
        raise InvalidInput(f"{key} must be a non-negative number.")
    return int(round(value))


def _hash(data):
    value = _text(data, "answerHash", 32)
    if value and not all(char in "0123456789abcdef" for char in value):
        raise InvalidInput("answerHash must be hexadecimal.")
    return value


def _consistency(rows):
    """How often the same question to the same agent on the same payrun got the same answer."""
    groups = defaultdict(list)
    for row in rows:
        if row.answer_hash and row.answered_by not in ("error", "acknowledged"):
            groups[(str(row.agent_id), row.payrun_id, " ".join(row.question.lower().split()))].append(row)
    repeated = {key: items for key, items in groups.items() if len(items) > 1}
    varied = [(key, items) for key, items in repeated.items() if len({row.answer_hash for row in items}) > 1]
    varied.sort(key=lambda item: -len(item[1]))
    return {
        "repeatedQuestions": len(repeated),
        "consistent": len(repeated) - len(varied),
        "consistencyRate": _rate(len(repeated) - len(varied), len(repeated)),
        "variedAnswers": [{
            "question": key[2], "agentName": items[0].agent_name, "payrunId": key[1], "times": len(items),
            "distinctAnswers": len({row.answer_hash for row in items}),
            "answeredBy": sorted({row.answered_by for row in items}),
        } for key, items in varied[:5]],
    }


def record_interaction(domain_name, agent_id, data):
    """Stores one answered question and returns its ID."""
    domain = get_domain(domain_name)
    agent_uuid = _uuid(agent_id, "agent_id")
    if not isinstance(data, dict):
        raise InvalidInput("Interaction data must be an object.")
    answered_by = _text(data, "answeredBy", 40, required=True)
    if answered_by not in ANSWER_TYPES:
        raise InvalidInput(f"answeredBy must be one of {', '.join(ANSWER_TYPES)}.")
    check_status = _text(data, "checkStatus", 20)
    if check_status not in CHECK_STATUSES:
        raise InvalidInput("checkStatus must be passed, flagged, or empty.")
    # Empty when the answer did not load the payrun's findings (e.g. an error).
    findings = data.get("findings")
    if findings is not None and not isinstance(findings, dict):
        raise InvalidInput("findings must be an object.")
    findings = {severity: _count(findings, severity) for severity in SEVERITIES} if findings else {}
    try:
        amount = Decimal(str(data.get("amountAtRisk") or 0)).quantize(Decimal("0.01"))
    except InvalidOperation:
        raise InvalidInput("amountAtRisk must be a number.") from None
    if amount < 0:
        raise InvalidInput("amountAtRisk must not be negative.")
    agent = Agent.objects.filter(pk=agent_uuid, domain=domain).first()
    interaction = AgentInteraction.objects.create(
        domain=domain,
        agent_id=agent_uuid,
        agent_name=(agent.name if agent else _text(data, "agentName", 150)) or "Unknown agent",
        template_id=agent.template_id if agent else _text(data, "templateId", 100),
        source=_text(data, "source", 60),
        session_id=_text(data, "sessionId", 100),
        payrun_id=_text(data, "payrunId", 100),
        question=_text(data, "question", 500, required=True),
        answered_by=answered_by,
        intent=_text(data, "intent", 60),
        model_id=_text(data, "modelId", 100),
        latency_ms=_count(data, "latencyMs"),
        model_latency_ms=_count(data, "modelLatencyMs", nullable=True),
        prompt_tokens=_count(data, "promptTokens", nullable=True),
        completion_tokens=_count(data, "completionTokens", nullable=True),
        cached=bool(data.get("cached")),
        check_status=check_status,
        unverified_count=_count(data, "unverifiedCount"),
        findings=findings,
        amount_at_risk=amount,
        incident_id=_text(data, "incidentId", 100),
        suggested_count=_count(data, "suggestedCount"),
        error=_text(data, "error", 300),
        answer_hash=_hash(data),
    )
    return str(interaction.id)


@transaction.atomic
def rate_interaction(domain_name, interaction_id, rating):
    """Records a user's thumbs up or down on an answer; an empty rating clears it."""
    domain = get_domain(domain_name)
    if rating not in RATINGS:
        raise InvalidInput("rating must be up, down, or empty.")
    interaction = (AgentInteraction.objects.select_for_update()
                   .filter(pk=_uuid(interaction_id, "interaction_id"), domain=domain).first())
    if not interaction:
        raise NotFound("Answer not found in this domain.")
    interaction.feedback = rating
    interaction.feedback_at = timezone.now() if rating else None
    interaction.save(update_fields=["feedback", "feedback_at"])
    return str(interaction.id)


def _percentile(values, percent):
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(percent / 100 * len(ordered)) - 1)]


def _average(values):
    return round(sum(values) / len(values)) if values else None


def _rate(part, whole):
    return round(part / whole, 4) if whole else None


def _latency(rows):
    values = [row.latency_ms for row in rows]
    return {"avgLatencyMs": _average(values), "p95LatencyMs": _percentile(values, 95)}


def _helpful(rows):
    up = sum(row.feedback == "up" for row in rows)
    down = sum(row.feedback == "down" for row in rows)
    return {"up": up, "down": down, "helpfulRate": _rate(up, up + down)}


def agent_metrics(domain_name, agent_id="", since_hours=0):
    """Business and agent metrics for a domain, optionally one agent and a recent window."""
    domain = get_domain(domain_name)
    rows = AgentInteraction.objects.filter(domain=domain).exclude(source="benchmark")
    if agent_id:
        rows = rows.filter(agent_id=_uuid(agent_id, "agent_id"))
    if since_hours:
        if since_hours < 0:
            raise InvalidInput("since_hours must not be negative.")
        rows = rows.filter(created_at__gte=timezone.now() - timedelta(hours=since_hours))
    rows = list(rows.order_by("-created_at")[:MAX_ROWS])
    # Automatic checks after payroll changes (runtime/events.py) are not questions: they count
    # toward incidents and findings, and are reported separately.
    checks = [row for row in rows if row.source == REALTIME]
    all_rows, rows = rows, [row for row in rows if row.source != REALTIME]
    answered = [row for row in rows if row.answered_by != "error"]
    model_rows = [row for row in rows if row.answered_by in ("model", "anomaly-investigation")]
    checked = [row for row in model_rows if row.check_status]

    # Findings and dollars at risk describe a payrun, so each payrun counts once: its latest
    # answer that loaded the findings.
    payruns = {row.payrun_id for row in all_rows if row.payrun_id}
    latest_by_payrun = {}
    for row in all_rows:
        if row.payrun_id and row.findings and row.payrun_id not in latest_by_payrun:
            latest_by_payrun[row.payrun_id] = row
    findings = {severity: sum(row.findings.get(severity, 0) for row in latest_by_payrun.values()) for severity in SEVERITIES}
    incidents = {row.incident_id for row in all_rows if row.incident_id}

    by_type = defaultdict(list)
    for row in rows:
        by_type[row.answered_by].append(row)
    by_model = defaultdict(list)
    for row in rows:
        if row.model_id and row.answered_by in ("model", "rag", "anomaly-pipeline", "anomaly-investigation", "error"):
            by_model[row.model_id].append(row)
    by_agent = defaultdict(list)
    for row in rows:
        by_agent[str(row.agent_id)].append(row)

    # One bucket per hour (windows up to 48 hours) or per day, including quiet ones, so the
    # activity chart shows the whole window.
    hourly = bool(since_hours) and since_hours <= 48
    step = timedelta(hours=1) if hourly else timedelta(days=1)
    label = (lambda moment: moment.strftime("%Y-%m-%d %H:00")) if hourly else (lambda moment: moment.strftime("%Y-%m-%d"))
    timeline = Counter()
    timeline_errors = Counter()
    for row in rows:
        bucket = label(timezone.localtime(row.created_at))
        timeline[bucket] += 1
        timeline_errors[bucket] += row.answered_by == "error"
    if since_hours:
        now = timezone.localtime()
        moment = now - timedelta(hours=since_hours) + (step if not hourly else timedelta(0))
        while moment <= now:
            timeline.setdefault(label(moment), 0)
            moment += step
    questions = Counter(" ".join(row.question.lower().split()) for row in answered)

    return {
        "window": {"sinceHours": since_hours or None, "agentId": agent_id or None, "rows": len(all_rows),
                   "truncated": len(all_rows) == MAX_ROWS},
        "summary": {
            "questions": len(rows),
            "conversations": len({row.session_id for row in rows if row.session_id}),
            "payrunsReviewed": len(payruns),
            "activeAgents": len(by_agent),
            "answeredFromData": len(by_type["payroll-data"]),
            "dataShare": _rate(len(by_type["payroll-data"]), len(answered)),
            "errors": len(by_type["error"]),
            **_latency(answered),
            **_helpful(rows),
        },
        "business": {
            "findings": findings,
            "amountAtRisk": float(sum((row.amount_at_risk for row in latest_by_payrun.values()), Decimal(0))),
            "incidentsRaised": len(incidents),
            "manualIncidents": len(by_type["incident-report"]),
            "realtimeChecks": len(checks),
            "realtimeIncidents": len({row.incident_id for row in checks if row.incident_id}),
            "warningsSuggested": sum(row.suggested_count for row in latest_by_payrun.values()),
            "topQuestions": [{"question": text, "count": count} for text, count in questions.most_common(TOP_QUESTIONS)],
        },
        "quality": {
            "modelAnswers": len(model_rows),
            "cached": sum(row.cached for row in model_rows),
            "cacheHitRate": _rate(sum(row.cached for row in model_rows), len(model_rows)),
            "checked": len(checked),
            "flagged": sum(row.check_status == "flagged" for row in checked),
            "checkPassRate": _rate(sum(row.check_status == "passed" for row in checked), len(checked)),
            "errorReasons": [{"reason": reason, "count": count} for reason, count in
                             Counter(row.error for row in by_type["error"] if row.error).most_common(5)],
            **_consistency(rows),
        },
        "answerTypes": [{"type": kind, "count": len(items), **_latency(items)}
                        for kind, items in sorted(by_type.items(), key=lambda item: -len(item[1])) if items],
        "models": [{
            "modelId": model_id,
            "calls": len(items),
            "errors": sum(row.answered_by == "error" for row in items),
            "avgLatencyMs": _average([row.model_latency_ms for row in items if row.model_latency_ms is not None]),
            "p95LatencyMs": _percentile([row.model_latency_ms for row in items if row.model_latency_ms is not None], 95),
            "promptTokens": sum(row.prompt_tokens or 0 for row in items),
            "completionTokens": sum(row.completion_tokens or 0 for row in items),
        } for model_id, items in sorted(by_model.items(), key=lambda item: -len(item[1]))],
        "agents": [{
            "agentId": key,
            "name": items[0].agent_name,
            "templateId": items[0].template_id,
            "questions": len(items),
            "dataShare": _rate(sum(row.answered_by == "payroll-data" for row in items),
                               sum(row.answered_by != "error" for row in items)),
            "errors": sum(row.answered_by == "error" for row in items),
            "flagged": sum(row.check_status == "flagged" for row in items),
            "incidents": len({row.incident_id for row in items if row.incident_id}),
            **_latency([row for row in items if row.answered_by != "error"]),
            **_helpful(items),
        } for key, items in sorted(by_agent.items(), key=lambda item: -len(item[1]))],
        "timeline": [{"bucket": bucket, "questions": timeline[bucket], "errors": timeline_errors[bucket]}
                     for bucket in sorted(timeline)],
        "recent": [{
            "id": str(row.id), "createdAt": row.created_at.isoformat(), "agentName": row.agent_name,
            "question": row.question, "answeredBy": row.answered_by, "modelId": row.model_id,
            "latencyMs": row.latency_ms, "checkStatus": row.check_status, "feedback": row.feedback,
            "incidentId": row.incident_id, "error": row.error,
        } for row in rows[:RECENT]],
    }
