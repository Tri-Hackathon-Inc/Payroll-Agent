"""Read current, scoped AD context for General Query; never initiate a review."""
from agents.anomaly_detection.models import AnomalyCase
from storage.models import Agent, AgentMessage
from runtime.agent_access import readable_sources


def payroll_chat_context(domain, run, employee_id=None, service=None, reader_id=None):
    source_ids = readable_sources(reader_id, domain)
    agents = Agent.objects.filter(domain_id=domain, template_id="anomaly-detection", pk__in=source_ids)
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
    incidents = Agent.objects.filter(domain_id=domain, template_id="incident-report", pk__in=source_ids)
    incident_ids = [agent.pk for agent in incidents if agent.config.get("service") == service and agent.config.get("page") == "payrun"]
    reports = []
    messages = AgentMessage.objects.filter(domain_id=domain, recipient_id__in=incident_ids,
                 source_version=run.get("version", 0), service=service, capability="incident-report", status="completed").order_by("-created_at")
    for message in messages[:30]:
        incident = message.result.get("incident", {})
        if incident.get("payrunId") != run["id"]:
            continue
        source = AnomalyCase.objects.filter(pk=message.source_reference, domain_id=domain, payrun_id=run["id"], payrun_version=run.get("version", 0)).first()
        if source is None or source.snapshot.get("scope", source.snapshot.get("employeeId")) != (employee_id or None):
            continue
        reports.append({"sourceAgentId": str(message.recipient_id), "reportId": incident.get("id"),
                        **{key: incident.get(key) for key in ("title", "expectedBehavior", "impactedService", "severity")},
                        "summary": str(message.result.get("reply", ""))[:2000],
                        "findings": [{key: item.get(key) for key in ("employeeId", "name", "kind", "detail", "severity")} for item in incident.get("evidence", [])[:20]]})
        if len(reports) == 3:
            break
    result["incidentReports"] = reports
    subject = "this employee's paycheck" if employee_id else "this payrun"
    result["predefinedQuestions"] = [
        f"What needs attention in {subject}?", f"What changed in {subject}?",
        "What should I verify next?" if result.get("decision") == "REVIEW" else "What did the latest check establish?",
        "What did the investigation conclude?" if result["status"] == "investigation" else "Why did Jev make this decision?",
    ]
    return result
