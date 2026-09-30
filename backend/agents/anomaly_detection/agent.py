"""The anomaly agent owns detection, persisted flags and explicit human review."""
import hashlib
import re
import time
from datetime import timedelta
from uuid import uuid4

from django.db.models import Q
from django.utils import timezone
from agents.agent import ConfiguredAgent
from runtime import access
from runtime.common import RuntimeFailure, digest, now_iso
from runtime.payroll import load_context
from .logic import PayrollAnomalyDetector
from .models import AnomalyCase


def case_data(case):
    return {
        "id": case.id, "domainName": case.domain_id, "agentId": str(case.agent_id),
        "agentName": case.agent_name, "payrunId": case.payrun_id, "version": case.payrun_version,
        "decision": case.decision, "reviewStatus": case.review_status, "summary": case.summary,
        "findings": case.snapshot["detection"]["findings"], "investigation": case.investigation,
        "createdAt": case.created_at.isoformat(),
        "reviewedAt": case.reviewed_at.isoformat() if case.reviewed_at else None,
    }


class AnomalyDetectionAgent(ConfiguredAgent):
    def __init__(self, definition, *, detector=None, **dependencies):
        super().__init__(definition, **dependencies)
        self.detector = detector or PayrollAnomalyDetector()

    def check(self, context, *, employee_id=None, persist=True):
        detection = self.detector.detect(context, employee_id)
        if not persist:
            return detection, None
        version = context["current"].get("version")
        if isinstance(version, bool) or not isinstance(version, (int, float)) or version <= 0 or int(version) != version:
            raise RuntimeFailure("Saved anomaly checks require a positive payroll version.", 400)
        identity = digest([self.definition["domain_name"], self.definition["id"], detection["id"], employee_id])
        case, _ = AnomalyCase.objects.get_or_create(id=identity, defaults={
            "domain_id": self.definition["domain_name"], "agent_id": self.definition["id"],
            "agent_name": self.definition["name"], "payrun_id": context["current"]["id"],
            "payrun_version": int(version), "detector_version": detection["detectorVersion"],
            "decision": detection["decision"], "summary": detection["summary"],
            "snapshot": {"detection": detection, "context": context, "employeeId": employee_id},
            "review_status": "pending" if detection["decision"] != "NORMAL" else "not_required",
        })
        return detection, case

    def on_change(self, event, context):
        detection, case = self.check(context)
        evidence, findings = detection["analysis"], detection["findings"]
        employee = next((item for item in evidence["employees"] if item["employeeId"] == event.get("employeeId")), None)
        return {
            "type": "checked", "domainName": self.definition["domain_name"],
            "payrunId": case.payrun_id, "version": case.payrun_version, "checkedAt": now_iso(),
            "monitor": {"id": self.definition["id"], "name": self.definition["name"]},
            "reason": "a saved payroll change", "analysis": evidence, "findings": findings,
            "decision": detection["decision"], "anomaly": case_data(case),
            "detection": {key: detection[key] for key in ("id", "type", "detectorVersion")},
            "critical": sum(item["severity"] == "critical" for item in findings),
            "changedEmployee": {"employeeId": employee["employeeId"], "name": employee["name"],
                                "findings": [item for item in findings if item["employeeId"] == employee["employeeId"]]} if employee else None,
        }

    def respond(self, question, context, conversation, confirmation=None, *, load=load_context):
        # Chat and question selection never authorize anomaly inference.
        if not context.get("payrunId"):
            return {"answer": {"reply": "Select a payrun to check it, then choose Review to investigate a flagged result.", "answeredBy": "clarification"}}
        detection, case = self.check(load(context), employee_id=context.get("employeeId"))
        return {"answer": {"reply": detection["summary"] + (" Select Review to investigate." if case.decision != "NORMAL" else ""),
                           "answeredBy": "anomaly-detection", "decision": case.decision,
                           "analysis": detection["analysis"], "anomaly": case_data(case), "model": None, "metrics": None}}

    @staticmethod
    def preview(body, *, load=load_context):
        from .draft import preview
        return preview(body, load=load)

    def review(self, body, headers, *, load=load_context):
        if body.get("action") != "REVIEW":
            raise RuntimeFailure("Select Review to authorize this investigation.", 400)
        identity = body.get("anomalyId")
        if not isinstance(identity, str) or not re.fullmatch(r"[a-f0-9]{64}", identity):
            raise RuntimeFailure("A valid anomaly ID is required.", 400)
        case = AnomalyCase.objects.filter(id=identity, domain_id=self.definition["domain_name"], agent_id=self.definition["id"]).first()
        if case is None:
            raise RuntimeFailure("Anomaly not found for this agent and domain.", 404)
        version = body.get("expectedVersion")
        if isinstance(version, bool) or version != case.payrun_version:
            raise RuntimeFailure("This review refers to a different payroll version. Reload the payrun.", 409)
        if case.decision == "NORMAL":
            raise RuntimeFailure("This check has no findings requiring investigation.", 409)
        current = load({"payrunId": case.payrun_id})["current"]
        if current.get("version") != case.payrun_version or current.get("company") != case.snapshot["context"]["current"].get("company"):
            raise RuntimeFailure("Payroll changed after this check. Reload and review the latest findings.", 409)
        if case.review_status == "completed":
            return case_data(case)
        now, token = timezone.now(), uuid4()
        claimable = Q(review_status__in=["pending", "failed"]) | Q(review_status="investigating", review_started_at__lt=now-timedelta(minutes=5))
        claimed = AnomalyCase.objects.filter(pk=case.pk).filter(claimable).update(
            review_status="investigating", review_token=token, review_started_at=now,
            reviewer_hash=hashlib.sha256(headers["x-session-owner"].encode()).hexdigest(), investigation=None)
        if not claimed:
            case.refresh_from_db()
            return case_data(case)
        started = time.monotonic()
        try:
            from .investigation import investigate
            result = investigate(self.definition, case.snapshot["context"], case.snapshot["detection"], model=self.model)
        except Exception:
            result = {"summary": case.summary, "modelStatus": "unavailable", "reason": "Investigation is unavailable. Select Review to retry.", "evidence": [], "findings": []}
        from runtime.execution import record
        result["interactionId"] = record(self.definition["domain_name"], self.definition,
            "Review payroll anomaly", {"payrunId": case.payrun_id},
            {"reply": result["summary"], "answeredBy": "anomaly-investigation", "analysis": result.get("analysis"), "metrics": result.get("metrics")},
            (time.monotonic()-started)*1000, "anomaly-review", case.snapshot["context"])
        AnomalyCase.objects.filter(pk=case.pk, review_token=token).update(
            review_status="completed" if result.get("modelStatus") == "completed" else "failed",
            investigation=result, reviewed_at=timezone.now(), review_token=None)
        case.refresh_from_db()
        return case_data(case)


def list_anomalies(body, headers):
    access.require(headers, "testAgents")
    from template import services
    from storage.models import Agent
    domain, payrun = body.get("domainName"), body.get("payrunId")
    if not isinstance(domain, str) or not domain or not isinstance(payrun, str) or not payrun:
        raise RuntimeFailure("A domain and payrun are required.", 400)
    services.get_domain(domain)
    active = Agent.objects.filter(domain_id=domain, template_id="anomaly-detection").values_list("id", flat=True)
    cases = AnomalyCase.objects.filter(domain_id=domain, payrun_id=payrun, agent_id__in=active)
    latest, seen = [], set()
    for case in cases.order_by("-payrun_version", "-created_at")[:200]:
        key = (case.agent_id, case.snapshot.get("employeeId"))
        if key not in seen:
            seen.add(key)
            latest.append(case_data(case))
    return {"items": latest}


def review_anomaly(body, headers):
    access.require(headers, "testAgents")
    if not isinstance(headers.get("x-session-owner"), str) or not re.fullmatch(r"[a-f0-9]{64}", headers["x-session-owner"]):
        raise RuntimeFailure("A browser session is required for Review.", 400)
    from agent_factory.factory import AgentFactory
    agent = AgentFactory().load(body.get("domainName"), body.get("agentId"))
    if not isinstance(agent, AnomalyDetectionAgent):
        raise RuntimeFailure("Select an Anomaly Detection agent.", 400)
    return agent.review(body, headers, load=load_context)
