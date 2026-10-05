"""Official Jev wire contract and saved-agent integration; no external inference."""
import json
import os
from copy import deepcopy
from unittest.mock import Mock, patch

import httpx
from django.test import SimpleTestCase, TestCase

from agent_factory.factory import AgentFactory
from agents.anomaly_detection.components import DECISION_MODELS
from agents.anomaly_detection.decision import DecisionModelFailure
from agents.anomaly_detection.features.payroll import PayrollFeatureEnricher
from agents.anomaly_detection.jev import JevDecisionModel, ENDPOINT
from agents.anomaly_detection.models import AnomalyCase
from agents.pipeline import agent_pipeline
from storage.models import Agent, Domain
from template import services
from tests.test_anomaly_streaming import event
from tests.test_anomaly_evidence import context_fixture
from tests.test_runtime import fixture


def response(decision="REVIEW"):
    return {"model": "jev-1.13.0", "answers": {"anomaly_decision": {"type": "choice", "choice": decision,
        "confidence": 0.9, "probabilities": {key: 0.9 if key == decision else 0.05 for key in ("NORMAL", "REVIEW", "CRITICAL")}}},
        "usage": {"input_tokens": 100, "output_tokens": 20}}


def features(value=30):
    return {"record": event(4, value), "baselines": [{"count": 3, "mean": 8, "std": 1, "variance": 1, "min": 7, "max": 9, "p95": 9, "lastValue": 9}]}


@patch.dict(os.environ, {"TYPESAFE_API_KEY": "test-only-key", "JEV_MODEL": "jev-1.13.0", "JEV_TIMEOUT_SECONDS": "3"})
class JevClientTests(SimpleTestCase):
    @patch.dict(os.environ, JEV_PROVIDER="openrouter", JEV_MODEL="", OPENROUTER_API_KEY="router-test-key")
    def test_openrouter_endpoint_model_and_credential_are_isolated(self):
        observed = []
        scorer = JevDecisionModel(transport=httpx.MockTransport(lambda request: observed.append(request) or httpx.Response(200, json=response())))
        result = scorer.score(features())
        self.assertEqual(str(observed[0].url), "https://openrouter.ai/api/v1/systemone")
        self.assertEqual(observed[0].headers["authorization"], "Bearer router-test-key")
        self.assertEqual(json.loads(observed[0].content)["model"], "typesafe/jev-1.13")
        self.assertEqual(result["provider"], "openrouter")
        with patch.dict(os.environ, OPENROUTER_API_KEY=""):
            self.assertEqual(scorer.readiness()["status"], "missing_credentials")
        self.assertEqual(len(observed), 1)

    def test_official_choice_contract_and_compact_payroll_features(self):
        observed = []
        def handler(request):
            observed.append(request)
            return httpx.Response(200, json=response())
        scorer = JevDecisionModel(transport=httpx.MockTransport(handler))
        enriched = PayrollFeatureEnricher().enrich(fixture())
        original = deepcopy(enriched)
        prediction = scorer.score(enriched)
        request = observed[0]
        self.assertEqual(str(request.url), ENDPOINT)
        self.assertEqual(request.headers["authorization"], "Bearer test-only-key")
        payload = json.loads(request.content)
        self.assertEqual(set(payload), {"state", "questions", "model"})
        self.assertEqual(payload["questions"]["anomaly_decision"]["type"], "choice")
        self.assertEqual(prediction["decision"], "REVIEW")
        self.assertAlmostEqual(prediction["score"], 0.95)
        self.assertEqual(prediction["confidence"], 0.9)
        self.assertEqual(enriched, original)
        serialized = json.dumps(payload["state"])
        self.assertNotIn('"name"', serialized)
        self.assertNotIn('"employeeId"', serialized)
        self.assertNotIn('"history"', serialized)

    def test_records_use_their_own_measurements_without_raw_event_fields(self):
        observed = []
        scorer = JevDecisionModel(transport=httpx.MockTransport(lambda request: observed.append(json.loads(request.content)) or httpx.Response(200, json=response("NORMAL"))))
        prediction = scorer.score(features())
        state = observed[0]["state"]
        self.assertEqual(state["measurements"][0]["name"], "hours")
        self.assertEqual(state["entityType"], "leave-request")
        self.assertNotIn("tenant", state)
        self.assertNotIn("occurredAt", state)
        self.assertEqual(prediction["decision"], "NORMAL")

    def test_missing_key_and_oversized_features_never_make_requests(self):
        handler = Mock()
        scorer = JevDecisionModel(transport=httpx.MockTransport(handler))
        with patch.dict(os.environ, TYPESAFE_API_KEY=""), self.assertRaises(DecisionModelFailure) as error:
            scorer.score(features())
        self.assertEqual(error.exception.status, "missing_credentials")
        oversized = features()
        oversized["record"]["measurements"] *= 500
        with self.assertRaises(DecisionModelFailure) as error:
            scorer.score(oversized)
        self.assertEqual(error.exception.status, "input_too_large")
        handler.assert_not_called()

    def test_http_errors_are_actionable_and_never_expose_provider_bodies(self):
        for code, status in ((401, "authentication_failed"), (403, "authentication_failed"), (429, "rate_limited"), (529, "rate_limited"), (500, "unavailable"), (302, "unavailable")):
            with self.subTest(code=code):
                scorer = JevDecisionModel(transport=httpx.MockTransport(lambda request: httpx.Response(code, text="sensitive body", headers={"location": "https://untrusted.example"})))
                with self.assertRaises(DecisionModelFailure) as error:
                    scorer.score(features())
                self.assertEqual(error.exception.status, status)
                self.assertNotIn("sensitive", str(error.exception))

    def test_timeout_invalid_json_and_invalid_probabilities(self):
        scorer = JevDecisionModel(transport=httpx.MockTransport(Mock(side_effect=httpx.ReadTimeout("secret"))))
        with self.assertRaises(DecisionModelFailure) as error:
            scorer.score(features())
        self.assertEqual(error.exception.status, "timeout")
        malformed = [httpx.Response(200, text="not JSON"), httpx.Response(200, json={}), httpx.Response(200, json=[])]
        for changes in ({"choice": "APPROVE"}, {"confidence": True}, {"probabilities": {"NORMAL": .8, "REVIEW": .9, "CRITICAL": .1}}, {"probabilities": {"NORMAL": .9, "REVIEW": .05, "CRITICAL": .05}}):
            data = response()
            data["answers"]["anomaly_decision"].update(changes)
            malformed.append(httpx.Response(200, json=data))
        for reply in malformed:
            with self.subTest(reply=reply), self.assertRaises(DecisionModelFailure) as error:
                JevDecisionModel(transport=httpx.MockTransport(lambda request: reply)).score(features())
            self.assertEqual(error.exception.status, "invalid_response")


@patch.dict(os.environ, {"TYPESAFE_API_KEY": "", "STUDIO_ADMIN_KEY": "", "ADMIN_FEATURES": "all"})
class JevAgentTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="jev-leaves", label="Leaves", domain="Leaves")

    def setUp(self):
        self.saved = AgentFactory().create("payroll-services", "anomaly-detection", "Jev test", {"model": "poc-demo"})
        self.body = {"domainName": "payroll-services", "agentId": str(self.saved.id)}

    def test_default_agent_reports_missing_key_without_inference_or_false_success(self):
        with patch("httpx.Client") as network, patch("model.model.Model.generate") as llm:
            flow = agent_pipeline(self.body, {})
            self.assertEqual(flow["decisionModelSetup"]["status"], "missing_credentials")
            runtime = AgentFactory().load("payroll-services", str(self.saved.id))
            _, case = runtime.check(fixture())
            flow = agent_pipeline(self.body, {})
        network.assert_not_called()
        llm.assert_not_called()
        self.assertEqual(flow["decisionModel"]["status"], "missing_credentials")
        self.assertEqual(case.review_status, "pending")

    def test_saved_agent_runs_jev_once_per_check_and_only_review_calls_llm(self):
        scorer = JevDecisionModel(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response())))
        scorer.score = Mock(wraps=scorer.score)
        with patch.dict(os.environ, TYPESAFE_API_KEY="test-only-key"), patch.dict(DECISION_MODELS, jev=lambda: scorer):
            runtime = AgentFactory().load("payroll-services", str(self.saved.id))
            with patch.object(runtime.model, "generate") as llm:
                detection, case = runtime.check(context_fixture())
                self.assertEqual(detection["analysis"]["decisionModel"]["status"], "completed")
                self.assertEqual(detection["decision"], "REVIEW")
                again, same = runtime.check(context_fixture())
                self.assertEqual(same.id, case.id)
                self.assertEqual(again, detection)
                agent_pipeline(self.body, {})
                scorer.score.assert_called_once()
                llm.assert_not_called()
                from agents.anomaly_detection.investigation import evidence_sources
                sources = evidence_sources(context_fixture(), detection)
                llm.return_value = json.dumps({"answer": "Review the supplied measurements.", "sourceIds": [sources[0]["id"]],
                    "findings": [{"findingId": finding["id"], "explanation": "Decision model requested investigation.", "reviewAction": "Review the source."} for finding in detection["findings"]]})
                result = runtime.review({**self.body, "anomalyId": case.id, "action": "REVIEW", "expectedVersion": case.payrun_version},
                                        {"x-session-owner": "a" * 64}, load=lambda invocation: context_fixture())
                self.assertEqual(result["reviewStatus"], "completed")
                llm.assert_called_once()
                scorer.score.assert_called_once()

    def test_paycheck_reopen_runs_fresh_decision_and_event_retry_is_deduplicated(self):
        scorer = JevDecisionModel(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response('NORMAL'))))
        scorer.score = Mock(wraps=scorer.score)
        with patch.dict(os.environ, TYPESAFE_API_KEY='test-only-key'), patch.dict(DECISION_MODELS, jev=lambda: scorer):
            runtime = AgentFactory().load('payroll-services', str(self.saved.id))
            context = context_fixture()
            employee = context['current']['lines'][0]['employeeId']
            event = {'type': 'paycheck.opened', 'employeeId': employee, 'changedAt': '2026-10-04T10:00:00Z'}
            first = runtime.on_change(event, context)
            retry = runtime.on_change(event, context)
            reopened = runtime.on_change({**event, 'changedAt': '2026-10-04T10:01:00Z'}, context)
        self.assertEqual(scorer.score.call_count, 2)
        self.assertEqual(first['anomaly']['id'], retry['anomaly']['id'])
        self.assertNotEqual(first['anomaly']['id'], reopened['anomaly']['id'])
        self.assertEqual(reopened['scope'], employee)

    def test_records_recover_from_missing_key_without_reusing_failed_case(self):
        saved = Agent.objects.create(domain_id="jev-leaves", name="Leave decision", template_id="leaves", template_version=1,
            config={"domain": "Leaves", "model": "poc-demo", "anomaly": {"profile": "records"}}, model_config=self.saved.model_config)
        source = features(8)
        source["record"]["domainName"] = "jev-leaves"
        runtime = AgentFactory().load("jev-leaves", str(saved.id))
        _, failed = runtime.check(source)
        scorer = JevDecisionModel(transport=httpx.MockTransport(lambda request: httpx.Response(200, json=response("NORMAL"))))
        with patch.dict(os.environ, TYPESAFE_API_KEY="test-only-key"), patch.dict(DECISION_MODELS, jev=lambda: scorer):
            runtime = AgentFactory().load("jev-leaves", str(saved.id))
            result, successful = runtime.check(source)
        self.assertNotEqual(failed.id, successful.id)
        self.assertEqual(result["analysis"]["decisionModelStatus"], "completed")
        self.assertEqual(result["decision"], "NORMAL")
        self.assertEqual(AnomalyCase.objects.filter(agent_id=saved.id).count(), 2)

    def test_previews_skip_jev_and_model_normal_never_suppresses_rules(self):
        scorer = Mock(version="test-v1", score=Mock(return_value={"decision": "NORMAL", "score": 0.0}))
        with patch.dict(DECISION_MODELS, jev=lambda: scorer):
            runtime = AgentFactory().load("payroll-services", str(self.saved.id))
            result, case = runtime.check(fixture(), persist=False)
            self.assertEqual(result["analysis"]["decisionModelStatus"], "skipped")
            scorer.score.assert_not_called()
            self.assertIsNone(case)
            result, case = runtime.check(fixture())
            self.assertEqual(result["decision"], "REVIEW")
            self.assertTrue(result["findings"])

    def test_saved_none_selection_disables_jev_and_unknown_selection_is_rejected(self):
        saved = AgentFactory().create("payroll-services", "anomaly-detection", "Rules only", {"model": "poc-demo", "anomaly": {"decisionModel": "none"}})
        with patch("httpx.Client") as network:
            runtime = AgentFactory().load("payroll-services", str(saved.id))
            result, _ = runtime.check(context_fixture())
        network.assert_not_called()
        self.assertNotIn("decisionModel", result["analysis"])
        with self.assertRaises(services.InvalidInput):
            AgentFactory().create("payroll-services", "anomaly-detection", "Invalid", {"model": "poc-demo", "anomaly": {"decisionModel": "import.anything"}})
