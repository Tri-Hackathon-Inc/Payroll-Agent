"""Exercise interchangeable anomaly components with a non-payroll domain."""
import json
import os
from copy import deepcopy
from unittest.mock import Mock, patch
from uuid import uuid4

from django.test import TestCase
from agent_factory.factory import AgentFactory
from agents.anomaly_detection.agent import AnomalyDetectionAgent, case_data, feedback_anomaly, list_anomalies
from agents.anomaly_detection.components import DomainProfile, PROFILES, FEATURE_STORES, anomaly_settings
from agents.anomaly_detection.features.store import MemoryFeatureStore
from agents.anomaly_detection.ingestion.events import ingest, deliver
from agents.anomaly_detection.interface import EntityReference
from agents.anomaly_detection.models import AnomalyCase, AnomalyFeatures, AnomalyAudit
from agents.response.logic import validate_answer
from runtime.common import RuntimeFailure, digest
from storage.models import Agent, Domain
from template import services
from tests.test_runtime import fixture


class EquipmentDomain:
    source = {"asset": "pump-1", "revision": 7, "site": "north", "temperature": 110}

    def reference(self, context):
        return EntityReference("equipment", context["asset"], context["revision"], context["site"])

    def load(self, invocation):
        assert invocation["entityId"] == self.source["asset"]
        return deepcopy(self.source)

    def invocation(self, reference):
        return {"entityId": reference.identity, "entityType": reference.kind}

    def selected(self, invocation):
        return bool(invocation.get("entityId"))

    def scope(self, invocation):
        return invocation.get("scope")

    def event_details(self, event, detection):
        return {"reason": "a sensor update"}

    def record_review(self, *args):
        return None


class EquipmentEnricher:
    version = "temperature-v1"

    def enrich(self, context, scope=None):
        return {"temperature": context["temperature"], "limit": 90, "asset": context["asset"]}


class EquipmentDetector:
    def detect(self, features, scope=None):
        findings = [{"id": "temperature-high", "severity": "warning", "label": "High temperature",
                     "evidence": features}] if features["temperature"] > features["limit"] else []
        return {"id": digest(features), "type": "equipment.checked", "detectorVersion": "threshold-v1",
                "decision": "REVIEW" if findings else "NORMAL", "summary": "Inspect the equipment." if findings else "Normal.",
                "findings": findings, "analysis": {"findings": findings}}


class EquipmentTools:
    def collect(self, context, detection):
        return [{"id": "sensor-1", "temperature": context["temperature"]}]


class EquipmentInvestigator:
    def investigate(self, definition, context, detection, *, model, tools):
        sources = tools.collect(context, detection)
        parsed = validate_answer(model.generate([{"role": "user", "content": json.dumps(sources)}]), sources, detection["findings"])
        return {"modelStatus": "completed", "summary": parsed["answer"], "findings": parsed["findings"], "evidence": sources}


class ComponentTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="equipment", label="Equipment", domain="Operations")

    def setUp(self):
        self.saved = AgentFactory().create("payroll-services", "anomaly-detection", "Payroll", {"model": "poc-demo"})
        self.agent = AgentFactory().load("payroll-services", str(self.saved.id))
        self.headers = {"x-session-owner": "a" * 64}
        profile = DomainProfile("Operations", EquipmentDomain, {"sensors": EquipmentEnricher},
            {"threshold": EquipmentDetector}, {"grounded": EquipmentInvestigator}, {"sensors": EquipmentTools},
            {"enricher": "sensors", "detector": "threshold", "investigator": "grounded", "tools": "sensors"})
        profiles = patch.dict(PROFILES, equipment=profile)
        profiles.start()
        self.addCleanup(profiles.stop)

    def body(self, case, **extra):
        return {"anomalyId": case.id, "agentId": str(case.agent_id), "domainName": case.domain_id,
                "expectedVersion": case.payrun_version, **extra}

    def test_features_are_reused_and_isolated_by_source_version_and_agent(self):
        context = fixture()
        with patch.object(self.agent.components.enricher, "enrich", wraps=self.agent.components.enricher.enrich) as enrich:
            first, case = self.agent.check(context)
            again, duplicate = self.agent.check(context)
            self.assertEqual(first, again)
            self.assertEqual(case.pk, duplicate.pk)
            self.assertEqual(enrich.call_count, 1)
            context["current"]["version"] += 1
            self.agent.check(context)
            self.assertEqual(enrich.call_count, 2)
        other = AgentFactory().create("payroll-services", "anomaly-detection", "Second", {"model": "poc-demo"})
        AgentFactory().load("payroll-services", str(other.id)).check(context)
        self.assertEqual(AnomalyFeatures.objects.count(), 3)
        self.assertEqual(AnomalyCase.objects.count(), 3)
        self.assertEqual(case.decision, "REVIEW")

    def test_transient_checks_do_not_read_or_write_feature_store(self):
        store = Mock()
        self.agent.feature_store = store
        with patch.object(self.agent.model, "generate") as model:
            _, case = self.agent.check(fixture(), persist=False)
        self.assertIsNone(case)
        self.assertFalse(store.mock_calls)
        model.assert_not_called()
        self.assertFalse(AnomalyCase.objects.exists())

    def test_registered_store_is_replaceable_and_component_config_is_validated(self):
        with patch.dict(FEATURE_STORES, transient=MemoryFeatureStore):
            saved = AgentFactory().create("payroll-services", "anomaly-detection", "Custom store",
                                          {"model": "poc-demo", "anomaly": {"featureStore": "transient"}})
            loaded = AgentFactory().load("payroll-services", str(saved.id))
            self.assertIsInstance(loaded.feature_store, MemoryFeatureStore)
        for setting in ({"profile": "equipment"}, {"detector": "unknown"}, {"featureStore": "os.system"}, {"module": "anything"}):
            with self.subTest(setting=setting), self.assertRaises(ValueError):
                anomaly_settings({"domain": "Payroll", "anomaly": setting})

    def test_non_payroll_domain_uses_same_agent_review_gate_and_feedback(self):
        config = deepcopy(self.saved.config)
        config.update(domain="Operations", anomaly={"profile": "equipment"})
        saved = Agent.objects.create(domain_id="equipment", name="Equipment monitor", template_id="anomaly-detection",
            template_version=1, config=config, model_config=self.saved.model_config)
        agent = AgentFactory().load("equipment", str(saved.id))
        agent.model = Mock(generate=Mock(return_value=json.dumps({"answer": "Inspect the hot equipment.", "sourceIds": ["sensor-1"],
            "findings": [{"findingId": "temperature-high", "explanation": "Above the configured limit.", "reviewAction": "Inspect the sensor."}]})))
        tools = agent.components.tools = Mock(wraps=EquipmentTools())
        event = {"domainName": "equipment", "agentId": str(saved.id), "entityId": "pump-1", "entityType": "equipment", "version": 7}
        with patch("runtime.payroll.load_context", side_effect=AssertionError("Must not load payroll")):
            output = ingest(event, agent=agent)
            repeated = ingest(event, agent=agent)
            self.assertEqual(output["anomaly"]["id"], repeated["anomaly"]["id"])
            self.assertNotIn("payrunId", output)
            self.assertEqual(output["entityId"], "pump-1")
            agent.model.generate.assert_not_called()
            tools.collect.assert_not_called()
            case = AnomalyCase.objects.get(pk=output["anomaly"]["id"])
            with self.assertRaises(RuntimeFailure):
                agent.review(self.body(case, action="APPROVE"), self.headers)
            result = agent.review(self.body(case, action="REVIEW"), self.headers)
            self.assertEqual(result["reviewStatus"], "completed")
            agent.model.generate.assert_called_once()
            tools.collect.assert_called_once()
            agent.review(self.body(case, action="REVIEW"), self.headers)
            agent.model.generate.assert_called_once()
        self.assertEqual(set(case.audit.values_list("action", flat=True)), {"REVIEW_REQUESTED", "INVESTIGATION_COMPLETED"})
        with patch.dict(os.environ, STUDIO_ADMIN_KEY="", ADMIN_FEATURES="all"):
            listed = list_anomalies({"domainName": "equipment", "entityId": "pump-1", "entityType": "equipment"}, self.headers)
            self.assertEqual(listed["items"][0]["id"], case.id)
            body = self.body(case, action="CONFIRMED", note="Sensor inspected.", requestId=str(uuid4()))
            confirmed = feedback_anomaly(body, self.headers)
            self.assertEqual(confirmed["feedback"]["action"], "CONFIRMED")
            feedback_anomaly(body, self.headers)
            self.assertEqual(case.audit.filter(action="CONFIRMED").count(), 1)
            with self.assertRaises(RuntimeFailure):
                feedback_anomaly({**body, "action": "DISMISSED"}, self.headers)
            with self.assertRaises(RuntimeFailure):
                feedback_anomaly({**body, "domainName": "payroll-services", "agentId": str(self.saved.id)}, self.headers)
        agent.model.generate.assert_called_once()

    def test_feedback_cannot_bypass_review_and_version_or_permission_checks(self):
        _, case = self.agent.check(fixture())
        body = self.body(case, action="CONFIRMED", requestId=str(uuid4()))
        with patch.dict(os.environ, STUDIO_ADMIN_KEY="", ADMIN_FEATURES="all"):
            with self.assertRaises(RuntimeFailure) as error:
                feedback_anomaly(body, self.headers)
            self.assertEqual(error.exception.status, 409)
            case.review_status = "completed"
            case.save(update_fields=["review_status"])
            with self.assertRaises(RuntimeFailure):
                feedback_anomaly({**body, "expectedVersion": case.payrun_version + 1}, self.headers)
        with patch.dict(os.environ, STUDIO_ADMIN_KEY="test", USER_FEATURES="none"):
            with self.assertRaises(RuntimeFailure) as error:
                feedback_anomaly(body, self.headers)
            self.assertEqual(error.exception.status, 403)
        self.assertFalse(AnomalyAudit.objects.exists())

    def test_component_change_requires_a_new_check(self):
        _, case = self.agent.check(fixture())
        self.agent.components.settings = {**self.agent.components.settings, "featureStore": "none"}
        with patch.object(self.agent.components.investigator, "investigate") as investigate, self.assertRaises(RuntimeFailure) as error:
            self.agent.review(self.body(case, action="REVIEW"), self.headers)
        self.assertEqual(error.exception.status, 409)
        investigate.assert_not_called()

    def test_consumer_acknowledges_only_after_successful_handling(self):
        acknowledge = Mock()
        with self.assertRaises(RuntimeError):
            deliver({}, acknowledge, handler=Mock(side_effect=RuntimeError("Storage unavailable")))
        acknowledge.assert_not_called()
        self.assertEqual(deliver({}, acknowledge, handler=lambda event: "saved"), "saved")
        acknowledge.assert_called_once()
