"""Read-only pipeline projection from configuration and persisted check evidence."""
import re

from django.db.models import F

from agent_factory.factory import AgentFactory
from agents.anomaly_detection.agent import AnomalyDetectionAgent, case_data
from agents.anomaly_detection.models import AnomalyCase
from runtime import access
from runtime.common import RuntimeFailure, now_iso


def stage(identity, label, status, detail):
    return {"id": identity, "label": label, "status": status, "detail": detail}


def feature_rows(detection, context):
    """Project saved detector inputs, without recalculating or loading source data."""
    analysis = detection.get("analysis", {})
    rows = []
    if "record" in context:
        for index, measurement in enumerate(context["record"].get("measurements", [])):
            baselines = context.get("baselines", [])
            baseline = baselines[index] if index < len(baselines) else {}
            rows.append({"name": measurement["name"], "scope": measurement.get("dimensions", {}),
                         "current": measurement.get("value"), "unit": measurement.get("unit", ""),
                         "baseline": baseline.get("mean"), "baselineKind": "Mean", "historyCount": baseline.get("count", 0),
                         "details": {key: value for key, value in baseline.items() if key in
                                     ("variance", "std", "min", "max", "p95", "lastValue")}})
    else:
        for employee in analysis.get("employees", []):
            for name, value in employee.get("current", {}).items():
                comparison = employee.get("comparisons", {}).get(name, {})
                rows.append({"name": name, "scope": {"employeeId": employee["employeeId"]}, "current": value,
                             "unit": comparison.get("unit", ""), "baseline": comparison.get("baseline"),
                             "baselineKind": "Median", "historyCount": comparison.get("historyCount", 0),
                             "details": {key: comparison[key] for key in ("delta", "percentChange") if key in comparison}})
    return {"rows": rows[:200], "total": len(rows), "truncated": len(rows) > 200}


def check_summary(case):
    return {"id": case["id"], "entityId": case["payrun_id"], "entityType": case["entity_type"],
            "version": case["payrun_version"], "decision": case["decision"],
            "createdAt": case["created_at"].isoformat(), "reviewStatus": case["review_status"], "tenant": case["tenant"]}


def agent_pipeline(body, headers):
    viewer = access.require(headers, "testAgents", "manageAgents")
    runtime = AgentFactory().load(body.get("domainName"), body.get("agentId"))
    definition = runtime.definition
    model = definition.get("model_config", {})
    model_label = model.get("name") or definition["config"].get("model", "Selected model")
    result = {"agentId": definition["id"], "agentName": definition["name"], "updatedAt": now_iso(),
              "model": {"name": model_label, "provider": model.get("provider"), "enabled": model.get("enabled", True)},
              "checks": [], "check": None, "features": {"rows": [], "total": 0, "truncated": False},
              "audit": [], "canReview": False, "configurationChanged": False}
    if not isinstance(runtime, AnomalyDetectionAgent):
        query, response = runtime.settings["query"], runtime.settings["response"]
        return result | {"kind": "conversation", "profile": "conversation", "components": {}, "stages": [
            stage("source", "User question", "configured", "A submitted message starts the conversation pipeline."),
            stage("query", "Query & evidence", "configured" if query["enabled"] else "disabled",
                  "Payrun context enables question matching and historical retrieval." if query["questionMatching"] else "Payrun context enables historical retrieval using the submitted question."),
            stage("llm", "LLM response", "configured" if model.get("enabled", True) else "disabled", model_label),
            stage("response", "Response", "configured", "Grounded answers validate evidence; optional presentation processing is " + ("enabled." if response["enabled"] else "disabled.")),
        ]}

    cases = AnomalyCase.objects.filter(domain_id=definition["domain_name"], agent_id=definition["id"]).order_by("-created_at", "-id")
    # List compact metadata; load the potentially large evidence snapshot only for the selected check.
    summaries = cases.values("id", "payrun_id", "entity_type", "payrun_version", "decision", "created_at", "review_status",
                             tenant=F("snapshot__context__record__tenant"))
    recent = list(summaries[:20])
    identity = body.get("anomalyId")
    if identity is not None:
        if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise RuntimeFailure("A valid anomaly ID is required.", 400)
        case = cases.filter(pk=identity).first()
        if case is None:
            raise RuntimeFailure("Anomaly not found for this agent and domain.", 404)
    else:
        case = cases.filter(pk=recent[0]["id"]).first() if recent else None
    if case and all(item["id"] != case.id for item in recent):
        recent.append(summaries.get(pk=case.id))
    settings = case.snapshot.get("components", runtime.components.settings) if case else runtime.components.settings
    changed = bool(case and settings != runtime.components.settings)
    detection = case.snapshot["detection"] if case else {}
    investigation = (case.investigation or {}) if case else {}
    review = case.review_status if case else "awaiting_data"
    normal = bool(case and case.decision == "NORMAL")
    # Status comes from saved execution evidence, never from the presence of a model option.
    decision_status = detection.get("analysis", {}).get("decisionModelStatus", "not_recorded" if case else "awaiting_data")
    configured = getattr(runtime.detector, "decision_model", None) is not None
    decision_metadata = detection.get("analysis", {}).get("decisionModel", {})
    readiness = runtime.detector.decision_model.readiness() if configured and hasattr(runtime.detector.decision_model, "readiness") else None
    if decision_status == "awaiting_data":
        if not configured:
            decision_status = "not_configured"
        elif readiness and readiness["status"] != "ready":
            decision_status = readiness["status"]
    decision_detail = {"not_configured": "No decision-model adapter is configured. Rules and statistics supply the decision.",
                       "not_recorded": "This check records a rules/statistics decision; no Jev invocation is recorded.",
                       "completed": "The decision-model adapter scored the generated features.",
                       "unavailable": "The decision-model call failed; rules and statistics supplied the decision."}.get(decision_status, "Waiting for a saved check.")
    decision_detail = decision_metadata.get("reason") or (readiness["reason"] if not case and readiness else decision_detail)
    if decision_metadata.get("status") == "completed":
        decision_detail = f"{decision_metadata.get('model', 'Decision model')} selected {decision_metadata['decision']}."
    gate = "not_required" if normal else "completed" if review in ("investigating", "completed", "failed") else "waiting" if case else "awaiting_data"
    llm = "not_required" if normal else {"pending": "waiting", "investigating": "running", "completed": "completed", "failed": "failed"}.get(review, "awaiting_data")
    audit = list(case.audit.order_by("-created_at", "-id")[:50]) if case else []
    review_request = next((item for item in audit if item.action == "REVIEW_REQUESTED"), None)
    reviewed_model = review_request.details.get("model") if review_request else None
    return result | {"kind": "anomaly", "profile": settings["profile"], "components": settings,
        "decisionModel": decision_metadata or None,
        "decisionModelSetup": readiness,
        "checks": [check_summary(item) for item in recent], "check": case_data(case) if case else None,
        "configurationChanged": changed,
        "canReview": bool(case and not normal and not changed and model.get("enabled", True)
                          and review in ("pending", "failed") and "testAgents" in viewer["features"]),
        "features": feature_rows(detection, case.snapshot["context"]) if case else result["features"],
        "audit": [{"action": item.action, "createdAt": item.created_at.isoformat()} for item in reversed(audit)],
        "stages": [
            stage("source", "Source data", "completed" if case else "awaiting_data",
                  f"{case.entity_type}: {case.payrun_id} · version {case.payrun_version}" if case else "Waiting for a saved source check."),
            stage("features", "Generated features", "completed" if case else "awaiting_data",
                  f"{settings['enricher']} enrichment · {settings['featureStore']} feature store"),
            stage("rules", "Rules & statistics", "completed" if case else "awaiting_data",
                  f"{detection.get('detectorVersion', settings['detector'])} · {case.decision}" if case else settings["detector"]),
            stage("decision", "Jev / decision model", decision_status, decision_detail),
            stage("review", "User Review", gate, "No review needed." if normal else "Select Review to authorize an LLM investigation." if gate != "completed" else "The user requested an investigation."),
            stage("llm", "LLM investigation", llm,
                  investigation.get("reason") or (f"{reviewed_model or model_label} · {investigation.get('modelStatus', 'completed')}" if llm == "completed"
                  else "Investigating saved evidence." if llm == "running" else f"{model_label} is invoked only after Review.")),
            stage("result", "Result & feedback", "completed" if normal or review == "completed" else "waiting" if case else "awaiting_data",
                  investigation.get("summary") or (case.summary if normal else "The investigation and human feedback are retained with this check.")),
        ]}
