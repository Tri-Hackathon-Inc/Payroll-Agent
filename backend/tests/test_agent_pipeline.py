"""Pipeline observation never loads source data, scores, or invokes a model."""
import os
from copy import deepcopy
from unittest.mock import Mock, patch

from django.test import TestCase
from google.protobuf.json_format import ParseDict, MessageToDict
from google.protobuf.struct_pb2 import Struct

from agent_factory.factory import AgentFactory
from agents.pipeline import agent_pipeline
from agents.anomaly_detection.models import AnomalyAudit, AnomalyCase, AnomalyFeatures
from agents.anomaly_detection.scoring import RecordDetector
from runtime.common import RuntimeFailure
from storage.models import Agent, Domain
from template import services
from tests.test_runtime import fixture
from tests.test_anomaly_streaming import event


@patch.dict(os.environ, {"STUDIO_ADMIN_KEY": "", "ADMIN_FEATURES": "all"})
class AgentPipelineTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="other-pipeline", label="Other", domain="Payroll")
        Domain.objects.create(name="leaves-pipeline", label="Leaves", domain="Leaves")

    def setUp(self):
        self.saved = AgentFactory().create("payroll-services", "anomaly-detection", "Pipeline", {"model": "poc-demo", "anomaly": {"decisionModel": "none"}})
        self.runtime = AgentFactory().load("payroll-services", str(self.saved.id))
        self.body = {"domainName": "payroll-services", "agentId": str(self.saved.id)}

    def stages(self, result):
        return {item["id"]: item["status"] for item in result["stages"]}

    def test_empty_and_saved_payroll_pipeline_is_read_only(self):
        empty = agent_pipeline(self.body, {})
        self.assertIsNone(empty["check"])
        self.assertFalse(empty["canReview"])
        self.assertEqual(empty["features"]["rows"], [])
        detection, case = self.runtime.check(fixture())
        before = (AnomalyCase.objects.count(), AnomalyAudit.objects.count(), AnomalyFeatures.objects.count())
        with patch("model.model.Model.generate") as inference, patch("runtime.payroll.load_context") as source, \
                patch("agents.anomaly_detection.logic.PayrollAnomalyDetector.detect") as score:
            result = agent_pipeline(self.body, {})
            repeated = agent_pipeline(self.body, {})
        inference.assert_not_called()
        source.assert_not_called()
        score.assert_not_called()
        self.assertEqual(before, (AnomalyCase.objects.count(), AnomalyAudit.objects.count(), AnomalyFeatures.objects.count()))
        self.assertEqual(result["features"], repeated["features"])
        self.assertEqual(result["check"]["id"], case.id)
        gross = next(row for row in result["features"]["rows"] if row["name"] == "gross")
        comparison = detection["analysis"]["employees"][0]["comparisons"]["gross"]
        self.assertEqual(gross["baseline"], comparison["baseline"])
        self.assertEqual(gross["baselineKind"], "Median")
        self.assertEqual(self.stages(result)["decision"], "not_recorded")
        self.assertEqual(self.stages(result)["llm"], "waiting")
        self.assertTrue(result["canReview"])
        self.assertEqual(MessageToDict(ParseDict(result, Struct()))["check"]["id"], case.id)

    def test_explicit_review_progress_failure_completion_and_configuration_change(self):
        _, case = self.runtime.check(fixture())
        for review, status in (("investigating", "running"), ("failed", "failed"), ("completed", "completed")):
            case.review_status = review
            case.investigation = {"summary": "Saved explanation", "modelStatus": "completed" if review == "completed" else "unavailable"}
            case.save()
            result = agent_pipeline(self.body, {})
            self.assertEqual(self.stages(result)["llm"], status)
            self.assertEqual(result["canReview"], review == "failed")
        AnomalyAudit.objects.create(case=case, action="REVIEW_REQUESTED", reviewer_hash="a" * 64, details={"model": "model-used-at-review"})
        AnomalyAudit.objects.create(case=case, action="CONFIRMED", reviewer_hash="a" * 64, details={"note": "Confirmed by reviewer"})
        result = agent_pipeline(self.body, {})
        self.assertEqual(result["check"]["feedback"]["action"], "CONFIRMED")
        self.assertIn("model-used-at-review", next(item for item in result["stages"] if item["id"] == "llm")["detail"])
        self.saved.config["anomaly"]["featureStore"] = "none"
        self.saved.save()
        result = agent_pipeline(self.body, {})
        self.assertTrue(result["configurationChanged"])
        self.assertFalse(result["canReview"])
        self.assertEqual(result["components"]["featureStore"], "database")

    def test_scoped_check_selection_latest_and_permissions(self):
        context = fixture()
        _, first = self.runtime.check(context)
        newer = deepcopy(context)
        newer["current"]["version"] += 1
        _, second = self.runtime.check(newer)
        self.assertEqual(agent_pipeline(self.body, {})["check"]["id"], second.id)
        self.assertEqual(agent_pipeline(self.body | {"anomalyId": first.id}, {})["check"]["id"], first.id)
        another = AgentFactory().create("payroll-services", "anomaly-detection", "Another", {"model": "poc-demo"})
        with self.assertRaises(RuntimeFailure) as error:
            agent_pipeline(self.body | {"agentId": str(another.id), "anomalyId": first.id}, {})
        self.assertEqual(error.exception.status, 404)
        with self.assertRaises(services.NotFound):
            agent_pipeline(self.body | {"domainName": "other-pipeline"}, {})
        with patch.dict(os.environ, {"ADMIN_FEATURES": "none"}), self.assertRaises(RuntimeFailure) as error:
            agent_pipeline(self.body, {})
        self.assertEqual(error.exception.status, 403)
        with patch.dict(os.environ, {"ADMIN_FEATURES": "manageAgents"}):
            self.assertFalse(agent_pipeline(self.body, {})["canReview"])

    def test_record_features_and_decision_model_status_follow_saved_execution(self):
        saved = Agent.objects.create(domain_id="leaves-pipeline", name="Leave anomalies", template_id="leaves", template_version=1,
            config={"domain": "Leaves", "model": "poc-demo", "anomaly": {"profile": "records", "decisionModel": "none"}}, model_config=self.saved.model_config)
        runtime = AgentFactory().load("leaves-pipeline", str(saved.id))
        body = {"domainName": "leaves-pipeline", "agentId": str(saved.id)}
        context = {"record": event(4, 30, domainName="leaves-pipeline"),
                   "baselines": [{"count": 3, "mean": 8, "std": 1, "variance": 1, "min": 7, "max": 9, "p95": 9, "lastValue": 9}]}
        runtime.check(context)
        result = agent_pipeline(body, {})
        self.assertEqual(result["features"]["rows"][0]["current"], 30)
        self.assertEqual(result["features"]["rows"][0]["details"]["p95"], 9)
        self.assertEqual(result["features"]["rows"][0]["baselineKind"], "Mean")
        self.assertEqual(self.stages(result)["decision"], "not_configured")
        runtime.detector = RecordDetector(decision_model=Mock(score=Mock(return_value={"score": 0.8, "decision": "REVIEW"})))
        runtime.check(context)
        self.assertEqual(self.stages(agent_pipeline(body, {}))["decision"], "completed")
        runtime.detector = RecordDetector(decision_model=Mock(score=Mock(side_effect=ValueError("unavailable"))))
        context["record"]["version"] += 1
        runtime.check(context)
        self.assertEqual(self.stages(agent_pipeline(body, {}))["decision"], "unavailable")

    def test_normal_check_skips_review_and_conversation_agents_use_own_pipeline(self):
        _, case = self.runtime.check(fixture())
        case.decision, case.review_status = "NORMAL", "not_required"
        case.save()
        result = agent_pipeline(self.body, {})
        self.assertEqual(self.stages(result)["llm"], "not_required")
        self.assertFalse(result["canReview"])
        saved = AgentFactory().create("payroll-services", "general-query", "Questions", {"model": "poc-demo"})
        result = agent_pipeline(self.body | {"agentId": str(saved.id)}, {})
        self.assertEqual(result["kind"], "conversation")
        self.assertNotIn("decision", self.stages(result))
