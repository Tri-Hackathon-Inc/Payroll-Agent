"""Calculated detection and explicitly requested explanation, without hosted inference."""
import json
import os
from copy import deepcopy
from unittest.mock import Mock, patch

from django.test import SimpleTestCase

from agents.anomaly_detection.investigation import evidence_sources, investigate
from agents.anomaly_detection.logic import PayrollAnomalyDetector
from model.runtime import ModelConfigurationError, ModelExecutionError
from runtime.common import RuntimeFailure
from runtime.payroll import preprocess


def context_fixture():
    line = {
        "lineId": "line-1", "employeeId": "E1", "name": "Person Example",
        "payType": "hourly", "employmentStatus": "active", "paymentMethod": "Direct Deposit",
        "hours": {"regular": 80, "overtime": 0}, "earnings": {"regular": 1000, "overtime": 0, "bonus": 100, "reimbursement": 50},
        "gross": 1150, "net": 900, "taxes": {"federal": 100, "state": 50},
        "deductions": {"health": 50, "retirement401k": 50, "garnishment": 0},
    }
    current = {"id": "PR-CURRENT", "version": 2, "company": "Example", "currency": "USD", "frequency": "biweekly",
               "payDate": "2026-03-20", "periodStart": "2026-03-01", "periodEnd": "2026-03-14",
               "status": "PENDING_APPROVAL", "lines": [line]}
    history = [dict(deepcopy(current), id="PR-OLD-" + month, status="COMPLETED", payDate=f"2026-{month}-20",
                    periodStart=f"2026-{month}-01", periodEnd=f"2026-{month}-14") for month in ("02", "01")]
    return {"current": current, "history": history}


def definition():
    return {"model_config": {"id": "test", "provider": "demo", "model_id": "offline", "enabled": True}}


def response_model():
    def generate(messages, response_format=None):
        body = json.loads(messages[1]["content"])
        return json.dumps({
            "answer": "E1 has calculated changes that need review.",
            "sourceIds": [source["id"] for source in body["sources"]],
            "findings": [{"findingId": item["id"], "explanation": "E1 differs from the supplied comparison.",
                          "reviewAction": "Verify the authorized payroll records."} for item in body["calculatedEvidence"]["findings"]],
        })
    return Mock(generate=Mock(side_effect=generate), metrics=None)


class DetectorEvidenceTests(SimpleTestCase):
    def test_normal_with_no_inference_and_explicit_history_limits(self):
        context = context_fixture()
        with patch("agents.anomaly_detection.investigation.Model") as model:
            result = PayrollAnomalyDetector().detect(context)
        model.assert_not_called()
        self.assertEqual(result["decision"], "NORMAL")
        self.assertFalse(result["suspiciousFindings"])
        self.assertIn("limited", result["summary"])
        self.assertNotIn("confidence", result)

    def test_median_and_payrun_findings_cannot_be_normal(self):
        context = context_fixture()
        context["current"]["lines"][0].update(gross=1700, net=1300)
        calculated = preprocess(context["current"], context["history"])
        result = PayrollAnomalyDetector().detect(context)
        self.assertEqual(result["decision"], "REVIEW")
        canonical = {item["id"]: item for item in result["analysis"]["findings"]}
        for item in calculated["findings"]:
            self.assertEqual(canonical[item["id"]], item)
        for item in calculated["payrunFindings"]:
            self.assertEqual(canonical[item["id"]]["evidence"], item["evidence"])
            self.assertIsNone(canonical[item["id"]]["employeeId"])
        self.assertEqual(len(canonical), len(result["analysis"]["findings"]))

    def test_policy_findings_are_included_in_strict_validation(self):
        context = context_fixture()
        context["current"]["lines"][0]["taxes"] = {"federal": 0, "state": 0}
        result = PayrollAnomalyDetector().detect(context)
        self.assertEqual(result["decision"], "CRITICAL")
        self.assertTrue(any(item["code"] == "no tax withholding" for item in result["analysis"]["findings"]))
        self.assertEqual(result["id"], PayrollAnomalyDetector().detect(context)["id"])

    def test_negative_net_and_employee_scope(self):
        context = context_fixture()
        context["current"]["lines"].append(dict(deepcopy(context["current"]["lines"][0]), employeeId="E2", lineId="line-2", net=-50))
        result = PayrollAnomalyDetector().detect(context, "E2")
        self.assertEqual(result["decision"], "CRITICAL")
        self.assertTrue(all(item["employeeId"] == "E2" for item in result["findings"]))
        self.assertFalse(result["analysis"]["payrunFindings"])


class InvestigationEvidenceTests(SimpleTestCase):
    def setUp(self):
        self.context = context_fixture()
        self.context["current"]["lines"][0]["earnings"]["bonus"] = 5000
        self.detection = PayrollAnomalyDetector().detect(self.context)

    def test_one_masked_model_call_with_known_citations_and_all_findings(self):
        original = deepcopy(self.context)
        model = response_model()
        result = investigate(definition(), self.context, self.detection, model=model)
        model.generate.assert_called_once()
        prompt = model.generate.call_args.args[0][1]["content"]
        self.assertNotIn("Person Example", prompt)
        self.assertEqual(result["modelStatus"], "completed")
        self.assertIn("Person Example", result["summary"])
        self.assertEqual({item["findingId"] for item in result["findings"]}, {item["id"] for item in self.detection["analysis"]["findings"]})
        self.assertTrue(all(item["cited"] for item in result["evidence"]))
        self.assertTrue(all("content" not in item for item in result["evidence"]))
        self.assertEqual(self.context, original)

    def test_default_wrapper_uses_only_saved_model_configuration_once(self):
        saved = definition()
        with patch("agents.anomaly_detection.investigation.Model", return_value=response_model()) as model:
            result = investigate(saved, self.context, self.detection)
        model.assert_called_once_with(saved["model_config"])
        self.assertEqual(result["modelStatus"], "completed")

    def test_full_payrun_retains_findings_and_sources_without_duplicate_comparisons(self):
        from tests.test_runtime import fixture
        context = fixture()
        detection = PayrollAnomalyDetector().detect(context)
        original = deepcopy(detection)
        model = response_model()
        result = investigate(definition(), context, detection, model=model)
        model.generate.assert_called_once()
        prompt = model.generate.call_args.args[0][1]["content"]
        body = json.loads(prompt)
        self.assertLess(len(prompt), 60000)
        self.assertEqual(result["modelStatus"], "completed")
        self.assertEqual({item["id"] for item in body["calculatedEvidence"]["findings"]},
                         {item["id"] for item in detection["analysis"]["findings"]})
        self.assertEqual({item["id"] for item in body["sources"]},
                         {item["id"] for item in evidence_sources(context, detection)})
        self.assertTrue(all("historyStatus" in item and "comparisons" not in item
                            for item in body["calculatedEvidence"]["employees"]))
        self.assertEqual(detection, original)

    def test_unknown_citation_or_missing_policy_comment_discards_model_output(self):
        for mutation in ("citation", "finding"):
            with self.subTest(mutation=mutation):
                model = response_model()
                valid = model.generate.side_effect

                def malformed(messages, response_format=None):
                    payload = json.loads(valid(messages, response_format))
                    if mutation == "citation":
                        payload["sourceIds"].append("invented")
                    else:
                        payload["findings"].pop()
                    return json.dumps(payload)

                model.generate.side_effect = malformed
                result = investigate(definition(), self.context, self.detection, model=model)
                if mutation == "finding":
                    self.assertEqual(result["modelStatus"], "partial_response")
                    self.assertEqual(result["coverage"]["explained"], result["coverage"]["total"] - 1)
                    self.assertEqual(len(result["coverage"]["unexplainedFindingIds"]), 1)
                    self.assertTrue(result["findings"])
                    continue
                self.assertEqual(result["modelStatus"], "invalid_response")
                self.assertEqual(result["findings"], [])
                self.assertEqual(result["summary"], self.detection["summary"])
                self.assertTrue(result["analysis"]["findings"])
                self.assertTrue(all(item["modelComment"] is None for item in result["analysis"]["findings"]))

    def test_failures_retain_evidence_without_raw_provider_errors(self):
        for mutation, message in (("citation", "cited evidence"), ("missing", "every supplied finding"), ("json", "complete JSON")):
            model = response_model()
            valid = model.generate.side_effect
            def malformed(messages, response_format=None):
                payload = json.loads(valid(messages, response_format))
                if mutation == "citation":
                    payload["sourceIds"] = ["unknown-source"]
                elif mutation == "missing":
                    payload["findings"] = []
                else:
                    return '{"answer":'
                return json.dumps(payload)
            model.generate.side_effect = malformed
            result = investigate(definition(), self.context, self.detection, model=model)
            self.assertEqual(result["modelStatus"], "invalid_response")
            self.assertIn(message, result["reason"])
            self.assertEqual(result["findings"], [])
            self.assertTrue(result["analysis"]["findings"])

    def test_provider_failures_retain_evidence_without_raw_errors(self):
        model = response_model()
        valid = model.generate.side_effect
        calls = []
        def generate(messages, response_format=None):
            calls.append(messages)
            if len(calls) == 1:
                payload = json.loads(valid(messages, response_format))
                payload["findings"] = []
                return json.dumps(payload)
            self.assertIn("requiredFindingIds", messages[-1]["content"])
            return valid(messages[:2], response_format)
        model.generate.side_effect = generate
        result = investigate(definition(), self.context, self.detection, model=model)
        self.assertEqual(result["modelStatus"], "completed")
        self.assertEqual(result["modelAttempts"], 2)
        self.assertEqual(result["coverage"]["explained"], result["coverage"]["total"])
        model.generate.side_effect = lambda messages, response_format=None: '{"answer":"Review", "sourceIds":[], "findings":[]}'
        model.generate.reset_mock()
        result = investigate(definition(), self.context, self.detection, model=model)
        self.assertEqual(model.generate.call_count, 2)
        self.assertEqual(result["modelStatus"], "invalid_response")
        self.assertTrue(result["analysis"]["findings"])

    def test_provider_failures_do_not_retry_or_expose_raw_errors(self):
        for error, status in ((ModelConfigurationError("secret detail"), "not_configured"), (ModelExecutionError("secret detail"), "unavailable")):
            with self.subTest(status=status):
                result = investigate(definition(), self.context, self.detection, model=Mock(generate=Mock(side_effect=error)))
                self.assertEqual(result["modelStatus"], status)
                self.assertTrue(result["analysis"]["findings"])
                self.assertNotIn("secret detail", json.dumps(result))

    def test_known_provider_failures_explain_next_steps_without_raw_errors(self):
        from model.runtime import ModelTimeout
        for error, expected in ((ModelExecutionError("secret provider body", reason_code="authentication"), "rejected the configured credential"),
                                (ModelExecutionError("secret provider body", reason_code="rate_limit"), "limiting requests"),
                                (ModelTimeout("secret provider body"), "time limit")):
            with self.subTest(error=expected):
                result = investigate(definition(), self.context, self.detection, model=Mock(generate=Mock(side_effect=error)))
                self.assertIn(expected, result["reason"])
                self.assertNotIn("secret provider body", json.dumps(result))
                self.assertTrue(result["analysis"]["findings"])

    def test_invalid_primary_then_backup_payment_error_identifies_huggingface(self):
        from agents.anomaly_detection.fallback import InvestigationModel
        primary = Mock(generate=Mock(return_value='{}'), metrics=None)
        backup = Mock(generate=Mock(side_effect=ModelExecutionError('private billing body', reason_code='credits')))
        routed = InvestigationModel(primary, primary_provider='huggingface', fallback_factory=Mock(return_value=backup))
        with patch.dict(os.environ, HF_TOKEN='test-only', AD_HF_FALLBACK='true'), patch(
                'agents.anomaly_detection.investigation.InvestigationModel', return_value=routed):
            result = investigate(definition(), self.context, self.detection, model=primary)
        self.assertIn('primary model answered', result['reason'])
        self.assertIn('Hugging Face backup', result['reason'])
        self.assertIn('HTTP 402', result['reason'])
        self.assertNotIn('no inference credits', result['reason'])
        self.assertNotIn('private billing body', json.dumps(result))
        self.assertEqual(result['modelRoute']['failureCode'], 'credits')
        self.assertEqual(result['modelAttempts'], 2)

    def test_normal_or_large_context_skips_inference(self):
        model = response_model()
        normal = context_fixture()
        result = investigate(definition(), normal, PayrollAnomalyDetector().detect(normal), model=model)
        self.assertEqual(result["modelStatus"], "not_needed")
        with patch("agents.anomaly_detection.investigation.MAX_CONTEXT_CHARACTERS", 10):
            result = investigate(definition(), self.context, self.detection, model=model)
        self.assertEqual(result["modelStatus"], "context_limit")
        model.generate.assert_not_called()

    def test_source_scope_and_stale_version(self):
        invalid = dict(deepcopy(self.context["history"][0]), id="WRONG-COMPANY", company="Other")
        self.context["history"].append(invalid)
        sources = evidence_sources(self.context, self.detection)
        self.assertNotIn("WRONG-COMPANY", {item["payrunId"] for item in sources})
        self.context["current"]["version"] += 1
        model = response_model()
        with self.assertRaises(RuntimeFailure) as raised:
            investigate(definition(), self.context, self.detection, model=model)
        self.assertEqual(raised.exception.status, 409)
        model.generate.assert_not_called()
