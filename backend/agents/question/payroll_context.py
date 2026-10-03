"""Read current, scoped AD context for General Query; never initiate a review."""
from agents.anomaly_detection.models import AnomalyCase
from storage.models import Agent


def payroll_chat_context(domain, run, employee_id=None, service=None):
    agents = Agent.objects.filter(domain_id=domain, template_id="anomaly-detection")
    eligible = [agent.id for agent in agents if agent.config.get("page") == "payrun"
                and agent.config.get("service") == service]
    cases = AnomalyCase.objects.filter(domain_id=domain, entity_type="payrun",
                                      payrun_id=run["id"], payrun_version=run.get("version", 0),
                                      agent_id__in=eligible).order_by("-created_at")
    result = {"status": "unavailable", "scope": employee_id or "payrun"}
    for case in cases:
        if case.snapshot.get("scope", case.snapshot.get("employeeId")) != (employee_id or None):
            continue
        if case.audit.filter(action="DISMISSED").exists():
            continue
        detection = case.snapshot.get("detection", {})
        investigation = case.investigation or {}
        complete = case.review_status == "completed" and investigation.get("modelStatus") == "completed"
        result.update(status="investigation" if complete else "decision", decision=case.decision,
                      summary=investigation.get("summary") if complete else case.summary,
                      findings=investigation.get("findings", []) if complete else detection.get("findings", []),
                      decisionModel=detection.get("analysis", {}).get("decisionModel"), version=case.payrun_version)
        break
    subject = "this employee's paycheck" if employee_id else "this payrun"
    result["predefinedQuestions"] = [
        f"What needs attention in {subject}?", f"What changed in {subject}?",
        "What should I verify next?" if result.get("decision") == "REVIEW" else "What did the latest check establish?",
        "What did the investigation conclude?" if result["status"] == "investigation" else "Why did Jev make this decision?",
    ]
    return result
