"""Anomaly detection and human review gates, without external model calls."""
import os
from copy import deepcopy
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TestCase

from agent_factory.factory import AgentFactory
from agents.anomaly_detection.agent import AnomalyDetectionAgent, list_anomalies, review_anomaly
from agents.anomaly_detection.logic import PayrollAnomalyDetector
from agents.anomaly_detection.models import AnomalyCase
from runtime.common import RuntimeFailure
from runtime.events import process
from storage.models import Agent, AgentInteraction, Domain
from template import services
from tests.test_runtime import fixture


class AnomalyDetectorTests(SimpleTestCase):
    def test_detector_is_deterministic_and_never_calls_a_model_or_delivery(self):
        context = fixture()
        with patch("model.model.Model.generate") as model, patch("runtime.incidents.raise_incidents") as delivery:
            result = PayrollAnomalyDetector().detect(context)
            repeated = PayrollAnomalyDetector().detect(context)
        model.assert_not_called()
        delivery.assert_not_called()
        self.assertEqual(result["payrunId"], context["current"]["id"])
        self.assertTrue(result["suspiciousFindings"])
        self.assertEqual(result["type"], "payroll.anomaly")
        self.assertIn(result["decision"], ("REVIEW", "CRITICAL"))
        self.assertTrue(all(item["severity"] in ("warning", "critical") for item in result["suspiciousFindings"]))
        self.assertEqual(result, repeated)


class AnomalyReviewTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="other", label="Other", domain="Payroll")

    def setUp(self):
        self.context = fixture()
        self.saved = self.create()
        self.agent = AgentFactory().load("payroll-services", str(self.saved.id))
        self.headers = {"x-session-owner": "a" * 64}
        self.success = {"summary": "Review the recorded overtime.", "modelStatus": "completed", "evidence": [], "findings": []}

    def create(self, domain="payroll-services"):
        return AgentFactory().create(domain, "anomaly-detection", "Payroll review", {"model": "poc-demo"})

    def check(self):
        detection, case = self.agent.check(self.context)
        self.assertNotEqual(case.decision, "NORMAL")
        return detection, case

    def body(self, case, **overrides):
        return {"domainName": case.domain_id, "agentId": str(case.agent_id), "anomalyId": case.id,
                "action": "REVIEW", "expectedVersion": case.payrun_version, **overrides}

    def review(self, case, **overrides):
        return self.agent.review(self.body(case, **overrides), self.headers, load=lambda _: self.context)

    def test_factory_loads_anomaly_agent_and_checks_persist_without_inference(self):
        self.assertIsInstance(self.agent, AnomalyDetectionAgent)
        before = deepcopy(self.context)
        with patch("model.model.Model.generate") as model, patch("runtime.incidents.raise_incidents") as delivery:
            detection, case = self.check()
            _, duplicate = self.check()
            chat = self.agent.respond("Review these findings now", {"payrunId": case.payrun_id}, {},
                                      load=lambda _: self.context)
        model.assert_not_called()
        delivery.assert_not_called()
        self.assertEqual(AnomalyCase.objects.count(), 1)
        self.assertEqual(duplicate.pk, case.pk)
        self.assertEqual(case.review_status, "pending")
        self.assertIsNone(case.investigation)
        self.assertEqual(case.snapshot["detection"], detection)
        self.assertEqual(case.snapshot["context"], before)
        self.assertEqual(self.context, before)
        self.assertEqual(chat["answer"]["anomaly"]["id"], case.id)
        self.assertIn("Review", chat["answer"]["reply"])

    def test_saved_events_publish_persisted_findings_without_inference_or_delivery(self):
        with patch("runtime.events.load_context", return_value=self.context), \
                patch("runtime.events.broadcast") as broadcast, patch("runtime.events.record") as record, \
                patch("model.model.Model.generate") as model, patch("runtime.incidents.raise_incidents") as delivery:
            process({"payrunId": self.context["current"]["id"], "employeeId": self.context["current"]["lines"][0]["employeeId"]})
        model.assert_not_called()
        delivery.assert_not_called()
        result = broadcast.call_args.args[0]
        case = AnomalyCase.objects.get(pk=result["anomaly"]["id"])
        self.assertEqual(case.review_status, "pending")
        self.assertEqual(result["type"], "checked")
        self.assertTrue(result["analysis"]["payrunFindings"])
        self.assertTrue(result["analysis"]["findings"])
        self.assertEqual(result["anomaly"]["findings"], case.snapshot["detection"]["findings"])
        self.assertEqual(result["version"], self.context["current"]["version"])
        self.assertEqual(record.call_args.args[6], "realtime-monitor")

    def test_admin_summary_uses_saved_evidence_and_separates_model_setup(self):
        from agents.anomaly_detection.agent import case_data
        _, case = self.check()
        result = case_data(case)["adminSummary"]
        self.assertTrue(result["priorities"])
        self.assertNotIn("TYPESAFE_API_KEY", result["summary"])
        self.assertTrue(any("histor" in text.lower() or "scoring" in text for text in result["limitations"]))
        self.assertIn("not confirmed errors", result["nextStep"])

    def test_pending_case_can_be_dismissed_without_model_inference(self):
        from uuid import uuid4
        from agents.anomaly_detection.feedback import record_feedback
        _, case = self.check()
        with patch("model.model.Model.generate") as model:
            result = record_feedback(self.agent, self.body(case, action="DISMISSED", note="Approved bonus", requestId=str(uuid4())), self.headers)
        model.assert_not_called()
        self.assertEqual(result["feedback"]["action"], "DISMISSED")
        self.assertEqual(result["feedback"]["note"], "Approved bonus")
        self.assertEqual(result["reviewStatus"], "pending")

    def test_paycheck_open_is_scoped_and_separate_from_payrun_check(self):
        employee = self.context["current"]["lines"][0]["employeeId"]
        with patch("model.model.Model.generate") as model:
            scoped = self.agent.on_change({"type": "paycheck.opened", "employeeId": employee}, self.context)
            full = self.agent.on_change({"type": "payrun.loaded"}, self.context)
        model.assert_not_called()
        self.assertEqual(scoped["scope"], employee)
        self.assertEqual(scoped["anomaly"]["scope"], employee)
        self.assertEqual(scoped["analysis"]["employeeId"], employee)
        self.assertIsNone(full["scope"])
        self.assertNotEqual(scoped["anomaly"]["id"], full["anomaly"]["id"])

    def test_human_review_invokes_investigation_once_and_caches_completed_result(self):
        detection, case = self.check()
        with patch("agents.anomaly_detection.investigation.investigate", return_value=self.success) as investigate, \
                patch("runtime.incidents.raise_incidents") as delivery:
            first = self.review(case)
            repeated = self.review(case)
        investigate.assert_called_once_with(self.agent.definition, self.context, detection, model=self.agent.model,
                                            tools=self.agent.components.tools)
        delivery.assert_not_called()
        self.assertEqual(first, repeated)
        self.assertEqual(first["reviewStatus"], "completed")
        self.assertEqual(first["investigation"], self.success)
        interaction = AgentInteraction.objects.get(pk=first["investigation"]["interactionId"])
        self.assertEqual(interaction.answered_by, "anomaly-investigation")
        self.assertEqual(interaction.source, "anomaly-review")
        self.assertEqual(AgentInteraction.objects.count(), 1)
        case.refresh_from_db()
        self.assertNotEqual(case.reviewer_hash, self.headers["x-session-owner"])
        self.assertEqual(len(case.reviewer_hash), 64)
        self.assertIsNotNone(case.reviewed_at)

    def test_concurrent_review_does_not_start_another_investigation(self):
        _, case = self.check()
        def in_progress(*args, **kwargs):
            repeated = self.review(case)
            self.assertEqual(repeated["reviewStatus"], "investigating")
            self.assertIsNone(repeated["investigation"])
            return self.success
        with patch("agents.anomaly_detection.investigation.investigate", side_effect=in_progress) as investigate:
            result = self.review(case)
        investigate.assert_called_once()
        self.assertEqual(result["reviewStatus"], "completed")

    def test_failed_investigation_requires_another_explicit_review_to_retry(self):
        _, case = self.check()
        with patch("agents.anomaly_detection.investigation.investigate", side_effect=[RuntimeError("provider unavailable"), self.success]) as investigate:
            failed = self.review(case)
            self.assertEqual(failed["reviewStatus"], "failed")
            self.assertEqual(failed["investigation"]["modelStatus"], "unavailable")
            self.agent.check(self.context)
            self.assertEqual(investigate.call_count, 1)
            completed = self.review(case)
        self.assertEqual(investigate.call_count, 2)
        self.assertEqual(completed["reviewStatus"], "completed")

    def test_invalid_action_and_expected_version_never_investigate(self):
        _, case = self.check()
        with patch("agents.anomaly_detection.investigation.investigate") as investigate, patch("model.model.Model.generate") as model:
            for action in (None, "review", "APPROVE", ""):
                with self.subTest(action=action), self.assertRaises(RuntimeFailure) as raised:
                    self.review(case, action=action)
                self.assertEqual(raised.exception.status, 400)
            for version in (None, -1, True, case.payrun_version + 1, str(case.payrun_version)):
                with self.subTest(version=version), self.assertRaises(RuntimeFailure) as raised:
                    self.review(case, expectedVersion=version)
                self.assertEqual(raised.exception.status, 409)
        investigate.assert_not_called()
        model.assert_not_called()
        case.refresh_from_db()
        self.assertEqual(case.review_status, "pending")

    def test_source_changes_reject_even_previously_completed_reviews(self):
        _, case = self.check()
        with patch("agents.anomaly_detection.investigation.investigate", return_value=self.success) as investigate:
            self.review(case)
            self.context["current"]["version"] += 1
            with self.assertRaises(RuntimeFailure) as raised:
                self.review(case)
        self.assertEqual(raised.exception.status, 409)
        investigate.assert_called_once()

    def test_normal_cases_cannot_invoke_investigation(self):
        normal = PayrollAnomalyDetector().detect(self.context)
        normal.update(decision="NORMAL", findings=[], suspiciousFindings=[], type="payroll.checked")
        self.agent.detector = Mock()
        self.agent.detector.detect.return_value = normal
        _, case = self.agent.check(self.context)
        with patch("agents.anomaly_detection.investigation.investigate") as investigate, self.assertRaises(RuntimeFailure) as raised:
            self.review(case)
        self.assertEqual(raised.exception.status, 409)
        investigate.assert_not_called()
        self.assertEqual(case.review_status, "not_required")

    def test_case_identity_is_bound_to_agent_and_domain(self):
        _, case = self.check()
        for other in (self.create(), self.create("other")):
            runtime = AgentFactory().load(other.domain_id, str(other.id))
            with patch("agents.anomaly_detection.investigation.investigate") as investigate, self.assertRaises(RuntimeFailure) as raised:
                runtime.review(self.body(case), self.headers, load=lambda _: self.context)
            self.assertEqual(raised.exception.status, 404)
            investigate.assert_not_called()

    def test_review_and_listing_enforce_permissions_before_loading_private_cases(self):
        _, case = self.check()
        with patch.dict(os.environ, {"STUDIO_ADMIN_KEY": "test-key", "USER_FEATURES": "none"}), \
                patch("agents.anomaly_detection.investigation.investigate") as investigate:
            for endpoint in (review_anomaly, list_anomalies):
                with self.subTest(endpoint=endpoint.__name__), self.assertRaises(RuntimeFailure) as raised:
                    endpoint(self.body(case) | {"payrunId": case.payrun_id}, self.headers)
                self.assertEqual(raised.exception.status, 403)
        investigate.assert_not_called()
        with patch.dict(os.environ, {"STUDIO_ADMIN_KEY": "", "ADMIN_FEATURES": "all"}):
            for owner in (None, "forged"):
                with self.assertRaises(RuntimeFailure) as raised:
                    review_anomaly(self.body(case), {"x-session-owner": owner})
                self.assertEqual(raised.exception.status, 400)

    def test_listing_returns_latest_scoped_cases_from_active_agents(self):
        _, older = self.check()
        self.context["current"]["version"] += 1
        _, latest = self.check()
        other = self.create("other")
        AgentFactory().load("other", str(other.id)).check(self.context)
        with patch.dict(os.environ, {"STUDIO_ADMIN_KEY": "", "ADMIN_FEATURES": "all"}):
            result = list_anomalies({"domainName": "payroll-services", "payrunId": latest.payrun_id}, self.headers)
            self.assertEqual([item["id"] for item in result["items"]], [latest.id])
            self.assertEqual(list_anomalies({"domainName": "payroll-services", "payrunId": "elsewhere"}, self.headers), {"items": []})
            Agent.objects.filter(pk=self.saved.pk).delete()
            self.assertEqual(list_anomalies({"domainName": "payroll-services", "payrunId": latest.payrun_id}, self.headers), {"items": []})
        self.assertTrue(AnomalyCase.objects.filter(pk=older.pk).exists())
