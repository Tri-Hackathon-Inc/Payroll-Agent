"""The anomaly agent owns detection, persisted flags and explicit human review."""
from runtime import agent_access
import hashlib
import re
import time
from datetime import timedelta
from uuid import uuid4
from dataclasses import asdict
from copy import deepcopy

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from agents.agent import ConfiguredAgent
from runtime import access
from runtime.common import RuntimeFailure, digest, now_iso, numeric
from runtime.payroll import load_context
from .components import AnomalyComponents
from .models import AnomalyCase, AnomalyAudit


def case_data(case):
    from .presentation import admin_summary
    feedback = case.audit.filter(action__in=["CONFIRMED", "DISMISSED"]).order_by("-created_at").first()
    return {
        "id": case.id, "domainName": case.domain_id, "agentId": str(case.agent_id),
        "agentName": case.agent_name, "entityType": case.entity_type, "entityId": case.payrun_id,
        **({"payrunId": case.payrun_id} if case.entity_type == "payrun" else {}), "version": case.payrun_version,
        "severity": case.snapshot["detection"].get("severity", "critical" if case.decision == "CRITICAL" else "warning"),
        "decision": case.decision, "reviewStatus": case.review_status, "summary": case.summary,
        "decisionModel": case.snapshot["detection"].get("analysis", {}).get("decisionModel"),
        **({"adminSummary": admin_summary(case.snapshot)} if case.entity_type == "payrun" else {}),
        "findings": case.snapshot["detection"]["findings"], "investigation": case.investigation,
        **({"tenant": case.snapshot["context"]["record"]["tenant"],
            "score": case.snapshot["detection"].get("score"), "scoreType": case.snapshot["detection"].get("scoreType")}
           if "record" in case.snapshot["context"] else {}),
        "createdAt": case.created_at.isoformat(),
        "scope": case.snapshot.get("scope", case.snapshot.get("employeeId")),
        "reviewedAt": case.reviewed_at.isoformat() if case.reviewed_at else None,
        "feedback": {"action": feedback.action, "note": feedback.details.get("note", ""),
                     "createdAt": feedback.created_at.isoformat()} if feedback else None,
    }


class AnomalyDetectionAgent(ConfiguredAgent):
    def __init__(self, definition, *, detector=None, components=None, feature_store=None, **dependencies):
        super().__init__(definition, **dependencies)
        self.components = components or AnomalyComponents(definition["config"])
        self.detector = detector or self.components.detector
        self.feature_store = feature_store if feature_store is not None else self.components.feature_store

    def check(self, context, *, scope=None, employee_id=None, persist=True):
        if "record" in context and context["record"].get("domainName") != self.definition["domain_name"]:
            raise RuntimeFailure("The source record belongs to a different domain.", 403)
        # employee_id is retained for existing payroll callers.
        if scope is not None and employee_id is not None and scope != employee_id:
            raise RuntimeFailure("Specify one anomaly scope.", 400)
        employee_id = scope if scope is not None else employee_id
        if employee_id is not None and (not isinstance(employee_id, str) or not 0 < len(employee_id) <= 100):
            raise RuntimeFailure("Anomaly scope must be a nonempty identifier of at most 100 characters.", 400)
        reference = self.components.domain.reference(context)
        version = reference.version
        if not numeric(version) or version <= 0 or int(version) != version:
            raise RuntimeFailure("Anomaly checks require a positive source version.", 400)
        if (not isinstance(reference.identity, str) or not 0 < len(reference.identity) <= 100
                or not isinstance(reference.kind, str) or not 0 < len(reference.kind) <= 60):
            raise RuntimeFailure("Anomaly checks require a valid entity type and ID.", 400)
        namespace = f"{self.definition['domain_name']}:{self.definition['id']}"
        cache_key = getattr(self.detector, "cache_key", None)
        cache_key = cache_key if isinstance(cache_key, str) else None
        feature_key = digest([asdict(reference), context, employee_id, self.components.settings,
                              self.components.enricher.version, *([cache_key] if cache_key else [])])
        if persist and cache_key:
            previous = AnomalyCase.objects.filter(domain_id=self.definition["domain_name"], agent_id=self.definition["id"],
                snapshot__featureKey=feature_key, snapshot__detection__analysis__decisionModelStatus="completed").first()
            if previous is not None:
                return deepcopy(previous.snapshot["detection"]), previous
        features = self.feature_store.get(namespace, feature_key) if persist else None
        if features is None:
            features = self.components.enricher.enrich(deepcopy(context), employee_id)
            if persist:
                self.feature_store.put(namespace, feature_key, features)
        detector = self.detector.detect_preview if not persist and cache_key else self.detector.detect
        detection = detector(deepcopy(features), employee_id)
        if detection.get("decision") not in ("NORMAL", "REVIEW", "CRITICAL"):
            raise RuntimeFailure("Detector returned an invalid review decision.", 500)
        detection = {**detection, "severity": "critical" if detection["decision"] == "CRITICAL" else detection.get("severity", "warning" if detection["decision"] == "REVIEW" else "info"),
                     "decision": "NORMAL" if detection["decision"] == "NORMAL" else "REVIEW"}
        if not persist:
            return detection, None
        identity = digest([namespace, asdict(reference), detection["id"], employee_id, feature_key])
        case, _ = AnomalyCase.objects.get_or_create(id=identity, defaults={
            "domain_id": self.definition["domain_name"], "agent_id": self.definition["id"],
            "agent_name": self.definition["name"], "payrun_id": reference.identity, "entity_type": reference.kind,
            "payrun_version": int(version), "detector_version": detection["detectorVersion"],
            "decision": detection["decision"], "summary": detection["summary"],
            "snapshot": {"detection": detection, "context": context, "employeeId": employee_id, "scope": employee_id,
                         "entity": asdict(reference), "components": self.components.settings, "featureKey": feature_key},
            "review_status": "pending" if detection["decision"] != "NORMAL" else "not_required",
        })
        return detection, case

    def on_change(self, event, context):
        scope = event.get("employeeId") if event.get("type") == "paycheck.opened" else None
        detection, case = self.check(context, scope=scope)
        evidence, findings = detection["analysis"], detection["findings"]
        return {
            "type": "checked", "domainName": self.definition["domain_name"],
            "entityId": case.payrun_id, "entityType": case.entity_type,
            **({"tenant": context["record"]["tenant"]} if "record" in context else {}),
            **({"payrunId": case.payrun_id} if case.entity_type == "payrun" else {}),
            "version": case.payrun_version, "checkedAt": now_iso(),
            "scope": scope,
            "monitor": {"id": self.definition["id"], "name": self.definition["name"]},
            "analysis": evidence, "findings": findings,
            "decision": detection["decision"], "anomaly": case_data(case),
            "detection": {key: detection[key] for key in ("id", "type", "detectorVersion")},
            "critical": sum(item["severity"] == "critical" for item in findings),
            **self.components.domain.event_details(event, detection),
        }

    def respond(self, question, context, conversation, confirmation=None, *, load=None):
        # Chat and question selection never authorize anomaly inference.
        if not self.components.domain.selected(context):
            return {"answer": {"reply": "Select a record to check it, then choose Review to investigate a flagged result.", "answeredBy": "clarification"}}
        invocation = {**context, "domainName": self.definition["domain_name"]}
        detection, case = self.check((load or self.components.domain.load)(invocation), scope=self.components.domain.scope(context))
        return {"answer": {"reply": detection["summary"] + (" Select Review to investigate." if case.decision != "NORMAL" else ""),
                           "answeredBy": "anomaly-detection", "decision": case.decision,
                           "analysis": detection["analysis"], "anomaly": case_data(case), "model": None, "metrics": None}}

    @staticmethod
    def preview(body, *, load=load_context):
        from .draft import preview
        return preview(body, load=load)

    def review(self, body, headers, *, load=None):
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
            raise RuntimeFailure("This review refers to a different source version. Reload the record.", 409)
        if case.decision == "NORMAL":
            raise RuntimeFailure("This check has no findings requiring investigation.", 409)
        saved_settings = case.snapshot.get("components")
        if ((saved_settings is not None and saved_settings != self.components.settings)
                or (saved_settings is None and self.components.settings["profile"] != "payroll")):
            raise RuntimeFailure("Anomaly components changed. Run a new check before Review.", 409)
        expected = self.components.domain.reference(case.snapshot["context"])
        current = self.components.domain.reference((load or self.components.domain.load)(self.components.domain.invocation(expected)))
        if current != expected:
            raise RuntimeFailure("Source data changed after this check. Reload and review the latest findings.", 409)
        if case.review_status == "completed":
            return case_data(case)
        now, token = timezone.now(), uuid4()
        claimable = Q(review_status__in=["pending", "failed"]) | Q(review_status="investigating", review_started_at__lt=now-timedelta(minutes=5))
        reviewer = hashlib.sha256(headers["x-session-owner"].encode()).hexdigest()
        with transaction.atomic():
            claimed = AnomalyCase.objects.filter(pk=case.pk).filter(claimable).update(
                review_status="investigating", review_token=token, review_started_at=now,
                reviewer_hash=reviewer, investigation=None)
            if claimed:
                AnomalyAudit.objects.create(case=case, action="REVIEW_REQUESTED", reviewer_hash=reviewer,
                                           details={"model": self.definition["config"].get("model"), "components": self.components.settings})
        if not claimed:
            case.refresh_from_db()
            return case_data(case)
        started = time.monotonic()
        try:
            result = self.components.investigator.investigate(self.definition, case.snapshot["context"], case.snapshot["detection"],
                                                             model=self.model, tools=self.components.tools)
        except Exception:
            result = {"summary": case.summary, "modelStatus": "unavailable", "reason": "Investigation is unavailable. Select Review to retry.", "evidence": [], "findings": []}
        try:
            result["interactionId"] = self.components.domain.record_review(self.definition, case, result, (time.monotonic()-started)*1000)
        except Exception:
            # Optional metrics must not strand a completed investigation.
            result["interactionId"] = None
        completed = result.get("modelStatus") == "completed"
        with transaction.atomic():
            updated = AnomalyCase.objects.filter(pk=case.pk, review_token=token).update(
                review_status="completed" if completed else "failed", investigation=result, reviewed_at=timezone.now(), review_token=None)
            if updated:
                AnomalyAudit.objects.create(case=case, action="INVESTIGATION_COMPLETED" if completed else "INVESTIGATION_FAILED",
                                           reviewer_hash=reviewer, details={"modelStatus": result.get("modelStatus")})
        case.refresh_from_db()
        return case_data(case)


def list_anomalies(body, headers):
    access.require(headers, "testAgents")
    from template import services
    from storage.models import Agent
    domain, payrun = body.get("domainName"), body.get("entityId", body.get("payrunId"))
    if not isinstance(domain, str) or not domain or not isinstance(payrun, str) or not payrun:
        raise RuntimeFailure("A domain and entity ID are required.", 400)
    entity_type = body.get("entityType", "payrun")
    if not isinstance(entity_type, str) or not 0 < len(entity_type) <= 60 or len(payrun) > 100:
        raise RuntimeFailure("Invalid anomaly entity type or ID.", 400)
    services.get_domain(domain)
    active = Agent.objects.filter(Q(template_id="anomaly-detection") | Q(config__anomaly__isnull=False), domain_id=domain).values_list("id", flat=True)
    cases = AnomalyCase.objects.filter(domain_id=domain, payrun_id=payrun, entity_type=entity_type, agent_id__in=active)
    if body.get("tenant"):
        from .records import identifier
        identifier(body["tenant"], "tenant")
        cases = cases.filter(snapshot__context__record__tenant=body["tenant"])
    else:
        cases = cases.filter(snapshot__context__record__isnull=True)
    latest, seen = [], set()
    for case in cases.order_by("-payrun_version", "-created_at")[:200]:
        key = (case.agent_id, case.snapshot.get("scope", case.snapshot.get("employeeId")))
        if key not in seen:
            seen.add(key)
            latest.append(case_data(case))
    return {"items": latest}


def authorized_agent(body, headers):
    access.require(headers, "testAgents")
    if not isinstance(headers.get("x-session-owner"), str) or not re.fullmatch(r"[a-f0-9]{64}", headers["x-session-owner"]):
        raise RuntimeFailure("A browser session is required for anomaly actions.", 400)
    from agent_factory.factory import AgentFactory
    agent = AgentFactory().load(body.get("domainName"), body.get("agentId"))
    if not isinstance(agent, AnomalyDetectionAgent):
        raise RuntimeFailure("Select an Anomaly Detection agent.", 400)
    return agent


def review_anomaly(body, headers):
    agent = authorized_agent(body, headers)
    agent_access.require_read(agent.definition)
    return agent.review(body, headers)


def feedback_anomaly(body, headers):
    from .feedback import record_feedback
    return record_feedback(authorized_agent(body, headers), body, headers)
