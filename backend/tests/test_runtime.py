"""Regression tests for the Python-owned payroll runtime (no paid providers)."""
import json
import os
import secrets
from copy import deepcopy
from pathlib import Path
from datetime import date, timedelta
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TestCase

from runtime import access
from runtime.common import RuntimeFailure
from runtime.events import preview, validate_event
from agents.anomaly_detection.rules import detect_signals
from runtime.payroll import eligible_history, pay_comparison, preprocess
from pipelines.payroll import answer_payroll, resolve_scope
from agents.response.logic import postprocess, validate_answer
from runtime.privacy import Pseudonymizer
from agents.question.logic import catalogue, question_flow
from runtime.retrieval import history_documents
from runtime.sessions import with_conversation


def fixture():
    data = json.loads(Path(__file__).with_name("fixtures").joinpath("payrun-PR-2026-09-B.json").read_text(encoding="utf-8"))
    current = data["payrun"]
    for index, line in enumerate(current["lines"]):
        line.setdefault("lineId", f"line-{index}")
    # The original UI fixture contains abbreviated history; construct dated, scoped
    # completed records for runtime tests, as returned by the payroll API.
    for run in data["payrunHistory"]:
        paid = date.fromisoformat(run["payDate"])
        run.update(status="COMPLETED", company=current["company"], currency=current["currency"], frequency=current["frequency"],
                   periodStart=(paid-timedelta(days=18)).isoformat(), periodEnd=(paid-timedelta(days=4)).isoformat())
    return {"current": current, "history": data["payrunHistory"]}


def agent():
    return {"id": "agent", "name": "Payroll agent", "config": {"service": "payrun", "questions": ["Why did net pay change?"]},
            "model_config": {"id": "offline", "model_id": "offline", "name": "Offline", "provider": "demo", "enabled": True}}


def valid_response(evidence, sources):
    return json.dumps({"answer": "Net pay changed; verify the recorded overtime.", "sourceIds": [item["id"] for item in sources],
                       "findings": [{"findingId": item["id"], "explanation": "The recorded value differs from historical payments.", "reviewAction": "Check the authorized payroll records."} for item in evidence["findings"]]})


class CalculationTests(SimpleTestCase):
    def setUp(self):
        self.context = fixture()

    def test_history_excludes_wrong_scope_dates_status_and_duplicates(self):
        current, history = self.context.values()
        original = deepcopy(history[0])
        extras = []
        for key, value in (("company", "other"), ("currency", "EUR"), ("frequency", "weekly"), ("status", "PENDING_APPROVAL"), ("payDate", current["payDate"]), ("periodEnd", current["periodStart"])):
            extras.append({**deepcopy(original), "id": "wrong-"+key, key: value})
        extras.extend([deepcopy(original), deepcopy(current)])
        self.assertEqual(eligible_history(current, history+extras), eligible_history(current, history))

    def test_aggregation_and_missing_values_are_not_zero(self):
        current = self.context["current"]
        line = deepcopy(current["lines"][0])
        current["lines"] = [line, deepcopy(line)]
        evidence = preprocess(current, self.context["history"])
        self.assertEqual(evidence["employees"][0]["current"]["gross"], line["gross"]*2)
        self.assertTrue(any(item["code"] == "multiple_lines" for item in evidence["findings"]))
        line["gross"] = None
        line["net"] = True
        evidence = preprocess(current, self.context["history"])
        self.assertIsNone(evidence["employees"][0]["current"]["gross"])
        self.assertIsNone(evidence["employees"][0]["current"]["net"])

    def test_no_history_preserves_current_and_does_not_invent_baseline(self):
        evidence = preprocess(self.context["current"], [])
        self.assertTrue(all(item["historyStatus"] == "insufficient" and not item["comparisons"] for item in evidence["employees"]))

    def test_pay_type_changes_excluded(self):
        identity = self.context["current"]["lines"][0]["employeeId"]
        for run in self.context["history"]:
            for line in run["lines"]:
                if line["employeeId"] == identity:
                    line["payType"] = "incompatible"
        evidence = preprocess(self.context["current"], self.context["history"], identity)
        self.assertEqual(evidence["employees"][0]["historyCount"], 0)
        self.assertIsNone(pay_comparison(self.context, evidence)["previous"])

    def test_zero_baseline_has_no_infinite_percentage(self):
        line = self.context["current"]["lines"][0]
        line["earnings"]["bonus"] = 500
        for run in self.context["history"]:
            for old in run["lines"]:
                if old["employeeId"] == line["employeeId"]:
                    old["earnings"]["bonus"] = 0
        result = preprocess(self.context["current"], self.context["history"], line["employeeId"])
        self.assertIsNone(result["employees"][0]["comparisons"]["bonus"]["percentChange"])

    def test_comparison_uses_latest_full_record_and_source_cents(self):
        current = self.context["current"]
        identity = current["lines"][0]["employeeId"]
        evidence = preprocess(current, self.context["history"], identity)
        result = pay_comparison(self.context, evidence)
        self.assertEqual(result["previous"]["payrunId"], eligible_history(current, self.context["history"])[0]["id"])
        net = next(row for row in result["rows"] if row["key"] == "net")
        self.assertAlmostEqual(result["netChange"], net["current"]-net["previous"], places=2)
        self.assertIsNone(pay_comparison(self.context, preprocess(current, self.context["history"])))

    def test_comparison_reconciliation_and_no_prior_history(self):
        current = self.context["current"]
        evidence = preprocess(current, [], current["lines"][0]["employeeId"])
        result = pay_comparison({"current": current, "history": []}, evidence)
        self.assertIsNone(result["previous"])
        self.assertFalse(result["reconciled"])
        self.assertTrue(all(row["delta"] is None for row in result["rows"]))

    def test_historical_document_ids_stable_and_scoped(self):
        docs = history_documents(self.context, "domain", "payrun")
        self.assertTrue(docs)
        self.assertFalse({item["id"] for item in docs} & {item["id"] for item in history_documents(self.context, "other-domain", "payrun")})
        identity = docs[0]["employeeId"]
        focused = history_documents(self.context, "domain", "payrun", [identity], ["overtime"])
        self.assertTrue(all(item["employeeId"] == identity and item["topic"] == "overtime" for item in focused))
        self.assertTrue({item["id"] for item in focused} <= {item["id"] for item in docs})

    def test_invalid_employee_and_dates_rejected(self):
        with self.assertRaises(RuntimeFailure):
            preprocess(self.context["current"], [], "unknown")
        self.context["current"]["payDate"] = "2026-02-30"
        with self.assertRaises(RuntimeFailure):
            preprocess(self.context["current"], [])

    def test_alert_policy_keeps_duplicate_tax_and_termination_checks(self):
        kinds = {item["kind"] for item in detect_signals(self.context["current"], self.context["history"]) if item["severity"] == "critical"}
        self.assertTrue({"duplicate payment", "no tax withholding", "paid after termination"} <= kinds)


class PostprocessingTests(SimpleTestCase):
    def setUp(self):
        self.context = fixture()
        self.evidence = preprocess(**{ "current": self.context["current"], "history": self.context["history"]})
        self.sources = history_documents(self.context, "domain", "payrun")[:3]
        self.text = valid_response(self.evidence, self.sources)

    def test_valid_answer_is_brief_and_details_are_separate(self):
        result = postprocess(self.evidence, self.sources, {"modelStatus": "completed", "text": self.text})
        self.assertEqual(result["analysis"]["modelStatus"], "completed")
        self.assertLess(len(result["reply"].split()), 60)
        self.assertIn("Historical sources:", result["analysis"]["details"])
        self.assertEqual(result["analysis"]["modelAnswer"]["sources"][0]["payrunId"], self.sources[0]["payrunId"])

    def test_invalid_citations_findings_and_structure_fall_back_to_calculations(self):
        parsed = json.loads(self.text)
        variants = [{**parsed, "sourceIds": ["forged"]}, {**parsed, "sourceIds": []}, {**parsed, "findings": []},
                    {**parsed, "findings": [parsed["findings"][0]]*len(parsed["findings"])}, {**parsed, "extra": "unsupported"}, {**parsed, "answer": "x\u0000"}]
        for value in variants:
            with self.subTest(value=str(value)[:80]):
                result = postprocess(self.evidence, self.sources, {"modelStatus": "completed", "text": json.dumps(value)})
                self.assertEqual(result["analysis"]["modelStatus"], "invalid_response")
                self.assertIsNone(result["analysis"]["modelAnswer"])
                self.assertEqual(len(result["analysis"]["findings"]), len(self.evidence["findings"]))

    def test_provider_failure_retains_comparison(self):
        self.evidence["payComparison"] = {"netChange": -283.78}
        result = postprocess(self.evidence, self.sources, {"modelStatus": "unavailable", "reason": "Model unavailable."})
        self.assertEqual(result["analysis"]["payComparison"]["netChange"], -283.78)

    def test_names_are_masked_but_citation_ids_never_rewritten(self):
        mask = Pseudonymizer(self.context)
        identity, name = next(iter(mask.people.items()))
        self.assertNotIn(name, mask.mask(json.dumps(self.context)))
        value = json.loads(mask.restore_json(json.dumps({"answer": identity, "sourceIds": [identity], "findings": [{"findingId": identity, "explanation": identity, "reviewAction": identity}]})))
        self.assertIn(name, value["answer"])
        self.assertEqual(value["sourceIds"], [identity])
        self.assertEqual(value["findings"][0]["findingId"], identity)


class QuestionTests(SimpleTestCase):
    def setUp(self):
        self.agent = agent()
        self.questions = catalogue(self.agent, "domain")
        self.store = Mock()
        self.store.search.return_value = [{**self.questions[0], "distance": 0.1}]
        self.answer = Mock(return_value={"reply": "Answer.", "focus": {"employeeIds": []}})
        self.state = {"scopeHash": "owned", "history": [], "focus": None}

    def flow(self, confirmation=None, now=1000):
        return question_flow(self.agent, "domain", "Why less?", confirmation, self.state, self.answer, self.store, now)

    def test_proposal_never_calls_payroll_or_llm_and_confirmation_does(self):
        result = self.flow()
        self.answer.assert_not_called()
        self.assertFalse(result["recordTurn"])
        self.state["pendingQuestion"] = result["pendingQuestion"]
        confirmed = self.flow({"mappingId": result["pendingQuestion"]["id"], "questionId": self.questions[0]["id"]})
        self.assertEqual(confirmed["answer"]["status"], "answered")
        self.answer.assert_called_once()

    def test_expiry_config_changes_and_forged_confirmation_rejected(self):
        proposal = self.flow()["pendingQuestion"]
        self.state["pendingQuestion"] = proposal
        valid = {"mappingId": proposal["id"], "questionId": self.questions[0]["id"]}
        for confirmation, now in (({**valid, "questionId": "forged"}, 1000), ({**valid, "mappingId": "forged"}, 1000), (valid, proposal["expiresAt"])):
            with self.assertRaises(RuntimeFailure):
                self.flow(confirmation, now)
        self.agent["config"]["instructions"] = "changed"
        with self.assertRaises(RuntimeFailure):
            self.flow(valid)
        self.answer.assert_not_called()

    def test_question_catalogue_normalizes_and_domain_scopes(self):
        self.agent["config"]["questions"] = ["  Why did net pay change? ", "WHY DID NET PAY CHANGE?"]
        self.assertEqual(len(catalogue(self.agent, "domain")), len(self.questions))
        self.assertFalse({q["id"] for q in self.questions} & {q["id"] for q in catalogue(self.agent, "other")})

    def test_search_failure_returns_safe_message_without_answer(self):
        self.store.search.side_effect = RuntimeError("secret-connection-string")
        with self.assertRaises(RuntimeFailure) as error:
            self.flow()
        self.assertNotIn("secret", str(error.exception))
        self.answer.assert_not_called()

    def test_employee_followups_all_scope_and_conflicts(self):
        lines = fixture()["current"]["lines"]
        identity, other = lines[0]["employeeId"], lines[1]["employeeId"]
        focus = {"employeeIds": [identity], "topics": ["earnings"]}
        self.assertEqual(resolve_scope("Why did his pay change?", lines, previous=focus)["employeeIds"], [identity])
        self.assertEqual(resolve_scope("What about all employees?", lines, previous=focus)["employeeIds"], [])
        self.assertIn("clarification", resolve_scope(other+" pay", lines, selected=identity))


class PreviewTests(SimpleTestCase):
    def setUp(self):
        permission = patch("runtime.events.agent_access.can_read", return_value=True)
        permission.start()
        self.addCleanup(permission.stop)
        self.context = fixture()
        line = next(item for item in self.context["current"]["lines"] if item["payType"] == "hourly")
        self.body = {"payrunId": self.context["current"]["id"], "lineId": line["lineId"], "expectedVersion": self.context["current"]["version"], "changes": {"hours": {"overtime": 180}}}

    def test_unsaved_draft_is_checked_without_mutating_source_or_delivering_incidents(self):
        before = deepcopy(self.context)
        with patch("runtime.incidents.raise_incidents") as incident, patch("runtime.events.broadcast") as broadcast:
            result = preview(self.body, load=lambda _: self.context)
        self.assertFalse(result["saved"])
        self.assertTrue(result["derivedAmountsPending"])
        self.assertTrue(any(item["code"] == "overtimeHours_change" for item in result["analysis"]["findings"]))
        self.assertIsNone(result["analysis"]["employees"][0]["current"]["net"])
        self.assertEqual(self.context, before)
        incident.assert_not_called()
        broadcast.assert_not_called()

    def test_stale_invalid_and_completed_drafts_rejected(self):
        for overrides in ({"expectedVersion": -1}, {"changes": {"net": 0}}, {"changes": {"hours": {"overtime": 201}}}):
            with self.assertRaises(RuntimeFailure):
                preview({**self.body, **overrides}, load=lambda _: self.context)
        self.context["current"]["status"] = "COMPLETED"
        with self.assertRaises(RuntimeFailure):
            preview(self.body, load=lambda _: self.context)

    def test_regular_hours_reimbursement_and_payment_method_are_checked_while_editing(self):
        line = next(item for item in self.context["current"]["lines"] if item["lineId"] == self.body["lineId"])
        other_method = "Live Check" if line["paymentMethod"] == "Direct Deposit" else "Direct Deposit"
        for changes, code in (({"hours": {"regular": 190}}, "regularHours_change"), ({"earnings": {"reimbursement": 100000}}, "reimbursement_change"), ({"paymentMethod": other_method}, "payment_method_change")):
            with self.subTest(code=code):
                result = preview({**self.body, "changes": changes}, load=lambda _: self.context)
                self.assertTrue(any(item["code"] == code for item in result["analysis"]["findings"]))

    def test_event_validation(self):
        self.assertEqual(validate_event({"type": "payrun.changed", "payrunId": "p", "version": 2.0})["version"], 2)
        for event in ({}, {"type": "payrun.changed", "payrunId": "../x"}, {"type": "payrun.changed", "payrunId": "p", "version": True}):
            with self.assertRaises(RuntimeFailure):
                validate_event(event)

    def test_read_events_require_domain_version_and_employee_scope(self):
        event = {"type": "paycheck.opened", "domainName": "payroll-services", "payrunId": "p", "version": 2, "lineId": "l", "employeeId": "e"}
        self.assertEqual(validate_event(event)["employeeId"], "e")
        for key in ("domainName", "version", "lineId", "employeeId"):
            with self.subTest(key=key), self.assertRaises(RuntimeFailure):
                validate_event({k: v for k, v in event.items() if k != key})

    def test_read_event_routes_to_its_domain_and_refuses_older_source_data(self):
        from runtime.events import process
        monitor = agent() | {"template_id": "anomaly-detection"}
        monitor["config"]["capabilities"] = {"alerts": {"enabled": True}}
        self.context["current"]["version"] = 3
        event = {"type": "payrun.loaded", "domainName": "domain", "payrunId": self.body["payrunId"], "version": 2}
        with patch("runtime.events.load_context", return_value=self.context), \
                patch("runtime.events.services.list_domains", return_value=[{"name": "other"}, {"name": "domain"}]), \
                patch("runtime.events.services.get_service_agent_registry", return_value=[monitor]) as registry, \
                patch("runtime.events.AnomalyDetectionAgent") as runtime, \
                patch("runtime.events.broadcast") as broadcast, patch("runtime.events.record"):
            runtime.return_value.on_change.return_value = {"anomaly": {"summary": "Checked"}}
            process(event)
            registry.assert_called_once_with("", "domain")
            runtime.return_value.on_change.assert_called_once_with(event, self.context)
            broadcast.reset_mock()
            with self.assertRaisesRegex(RuntimeFailure, "triggered version"):
                process({**event, "version": 4})
            broadcast.assert_not_called()

    def test_saved_events_delegate_to_the_anomaly_agent_and_broadcast_its_result(self):
        from runtime.events import process
        monitor = agent() | {"template_id": "anomaly-detection"}
        monitor["config"]["capabilities"] = {"alerts": {"enabled": True}}
        event = {"payrunId": self.body["payrunId"]}
        result = {"type": "checked", "anomaly": {"summary": "Payroll needs review."}, "decision": "REVIEW"}
        with patch("runtime.events.load_context", return_value=self.context), \
                patch("runtime.events.services.list_domains", return_value=[{"name": "domain"}]), \
                patch("runtime.events.services.get_service_agent_registry", return_value=[monitor]), \
                patch("runtime.events.AnomalyDetectionAgent") as runtime, \
                patch("runtime.incidents.raise_incidents") as incident, \
                patch("runtime.events.broadcast") as broadcast, \
                patch("runtime.events.record") as record:
            runtime.return_value.on_change.return_value = result
            process(event)
        runtime.assert_called_once_with(monitor | {"domain_name": "domain"})
        runtime.return_value.on_change.assert_called_once_with(event, self.context)
        broadcast.assert_called_once_with(result)
        incident.assert_not_called()
        self.assertEqual(record.call_args.args[6], "realtime-monitor")

    def test_failed_case_persistence_does_not_broadcast_or_investigate(self):
        from runtime.events import process
        monitor = agent() | {"template_id": "anomaly-detection"}
        monitor["config"]["capabilities"] = {"alerts": {"enabled": True}}
        with patch("runtime.events.load_context", return_value=self.context), \
                patch("runtime.events.services.list_domains", return_value=[{"name": "domain"}]), \
                patch("runtime.events.services.get_service_agent_registry", return_value=[monitor]), \
                patch("runtime.events.AnomalyDetectionAgent") as runtime, \
                patch("runtime.incidents.raise_incidents") as incident, \
                patch("runtime.events.broadcast") as broadcast, \
                patch("runtime.events.record") as record:
            runtime.return_value.on_change.side_effect = RuntimeError("Case storage unavailable")
            with self.assertRaisesRegex(RuntimeError, "Case storage unavailable"):
                process({"payrunId": self.body["payrunId"]})
        broadcast.assert_not_called()
        incident.assert_not_called()
        record.assert_not_called()


class MemoryRedis:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

    def set(self, key, value, nx=False, **kwargs):
        if nx and key in self.data:
            return False
        self.data[key] = value
        return True

    def expire(self, *args):
        pass

    def eval(self, script, count, *args):
        if count == 1:
            key, token = args
            if self.data.get(key) == token:
                del self.data[key]
                return 1
            return 0
        lock, key, token, data, ttl = args
        if self.data.get(lock) != token:
            return 0
        self.data[key] = data
        return 1


class SessionTests(SimpleTestCase):
    def setUp(self):
        self.store = MemoryRedis()
        self.options = {"question": "Hello", "scope": {"owner": "browser", "agentId": "agent"}, "context": {"payrunId": "p"}, "requestId": "one"}
        self.execute = Mock(return_value={"answer": {"reply": "Hello back"}, "focus": {"employeeIds": ["E1"]}})

    def test_retry_idempotency_scope_context_and_expiry(self):
        answer = with_conversation(self.options, self.execute, self.store)
        options = {**self.options, "sessionId": answer["session"]["id"]}
        self.assertEqual(with_conversation(options, self.execute, self.store), answer)
        self.execute.assert_called_once()
        for overrides in ({"question": "Other"}, {"scope": {"owner": "another"}}, {"context": {"payrunId": "another"}}, {"sessionId": "a"*64}):
            with self.assertRaises(RuntimeFailure):
                with_conversation({**options, **overrides}, self.execute, self.store)

    def test_pending_proposal_not_recorded_as_history(self):
        self.execute.return_value = {"answer": {"reply": "Select a question"}, "recordTurn": False, "pendingQuestion": {"id": "pending"}}
        answer = with_conversation(self.options, self.execute, self.store)
        state = json.loads(self.store.get("payroll:session:py:"+answer["session"]["id"]))
        self.assertEqual(state["history"], [])
        self.assertEqual(state["pendingQuestion"]["id"], "pending")

    def test_lock_prevents_concurrent_turn_and_bad_history(self):
        identity = "a"*64
        self.store.set("payroll:session:py:"+identity+":lock", "other")
        with self.assertRaises(RuntimeFailure):
            with_conversation({**self.options, "sessionId": identity}, self.execute, self.store)
        with self.assertRaises(RuntimeFailure):
            with_conversation({**self.options, "history": [{"role": "assistant", "content": "bad"}]}, self.execute, self.store)


class AccessTests(SimpleTestCase):
    @patch.dict(os.environ, {"STUDIO_ADMIN_KEY": "testing-secret", "CUSTOMER_MODELS": "allowed"})
    def test_python_enforces_login_feature_and_model_allow_list(self):
        self.assertEqual(access.viewer()["role"], "user")
        with self.assertRaises(RuntimeFailure):
            access.require({}, "manageAgents")
        with self.assertRaises(RuntimeFailure):
            access.check_choices({}, {"model": "denied"})
        login = access.authenticate({"key": "testing-secret"}, {"x-client-address": secrets.token_hex(16)})
        self.assertEqual(access.viewer({"cookie": login["cookie"]})["role"], "admin")
        self.assertEqual(access.viewer({"cookie": login["cookie"].replace("studio_admin=", "studio_admin=invalid")})["role"], "user")


class PipelineTests(SimpleTestCase):
    def test_retrieval_failure_does_not_invoke_model_and_retains_evidence(self):
        context = fixture()
        store, factory = Mock(), Mock()
        store.search.side_effect = RuntimeError("database-secret")
        identity = context["current"]["lines"][0]["employeeId"]
        result = answer_payroll(agent(), "domain", {"payrunId": context["current"]["id"], "employeeId": identity}, {}, {"id": "q", "text": "Compare net pay", "originalQuery": "Why less?"}, load=lambda _: context, store=store, runtime_factory=factory)
        factory.create.assert_not_called()
        self.assertEqual(result["retrieval"]["status"], "unavailable")
        self.assertIsNotNone(result["analysis"]["payComparison"])
        self.assertNotIn("database-secret", result["reply"])

    def test_pipeline_masks_employee_names_and_postprocesses_response(self):
        context = fixture()
        store, factory = Mock(), Mock()
        store.search.return_value = []

        def generate(messages):
            prompt = json.loads(messages[-1]["content"])
            self.assertNotIn(context["current"]["lines"][0]["name"], messages[-1]["content"])
            return valid_response(prompt["evidence"], [])

        runtime = factory.create.return_value
        runtime.generate.side_effect = generate
        runtime.metrics = None
        result = answer_payroll(agent(), "domain", {}, {}, {"id": "q", "text": "Summarize this payrun", "originalQuery": "Summary"}, load=lambda _: context, store=store, runtime_factory=factory)
        self.assertEqual(result["analysis"]["modelStatus"], "completed")
        self.assertEqual(result["reply"], "Net pay changed; verify the recorded overtime.")
