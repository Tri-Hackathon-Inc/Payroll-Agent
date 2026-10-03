from unittest.mock import patch
from django.test import TestCase
from agent_factory.factory import AgentFactory
from agents.question.payroll_context import payroll_chat_context
from storage.models import Domain
from template import services
from tests.test_runtime import fixture


class PayrollChatContextTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})

    def setUp(self):
        self.agent = AgentFactory().create("payroll-services", "anomaly-detection", "AD", {"model": "poc-demo", "page": "payrun"})
        self.runtime = AgentFactory().load("payroll-services", str(self.agent.pk))
        self.context = fixture()
        _, self.case = self.runtime.check(self.context)

    def read(self, employee=None, run=None, domain="payroll-services"):
        return payroll_chat_context(domain, run or self.context["current"], employee, self.agent.config["service"])

    def test_decision_then_validated_investigation(self):
        self.assertEqual(self.read()["status"], "decision")
        self.case.review_status = "completed"
        self.case.investigation = {"modelStatus": "completed", "summary": "Verify approved overtime.", "findings": []}
        self.case.save()
        self.assertEqual(self.read()["summary"], "Verify approved overtime.")
        self.assertIn("What did the investigation conclude?", self.read()["predefinedQuestions"])
        self.case.investigation["modelStatus"] = "invalid_response"
        self.case.save()
        self.assertEqual(self.read()["status"], "decision")

    def test_isolates_employee_domain_and_version(self):
        self.assertEqual(self.read("E1001")["status"], "unavailable")
        self.assertEqual(self.read(domain="other")["status"], "unavailable")
        self.assertEqual(self.read(run={**self.context["current"], "version": 999})["status"], "unavailable")
        _, employee_case = self.runtime.check(self.context, employee_id="E1001")
        self.assertEqual(self.read("E1001")["summary"], employee_case.summary)
        self.assertEqual(self.read()["summary"], self.case.summary)

    def test_detached_agent_is_excluded(self):
        self.agent.config["page"] = "other"
        self.agent.save()
        self.assertEqual(self.read()["status"], "unavailable")

    def test_general_query_maps_before_answering_without_visible_selection(self):
        saved = AgentFactory().create("payroll-services", "general-query", "Chat", {"model": "poc-demo"})
        runtime = AgentFactory().load("payroll-services", str(saved.pk))
        def search(questions, query, limit):
            match = next(item for item in questions if item["text"] == "Is the bonus unusual in this employee's paycheck?")
            return [{**match, "distance": 0.1}]
        with patch("agents.agent.answer_payroll", return_value={"reply": "Answer"}) as answer, patch("agents.question.logic.VectorStore") as store:
            store.return_value.search.side_effect = search
            result = runtime.respond("how unusual bonus?", {"page": "payrun", "payrunId": "run", "employeeId": "E1001"}, {})
        self.assertEqual(result["answer"]["status"], "answered")
        mapped = answer.call_args.args[4]
        self.assertEqual(mapped["text"], "Is the bonus unusual in this employee's paycheck?")
        self.assertEqual(mapped["originalQuery"], "how unusual bonus?")
        self.assertFalse(mapped["confirmed"])
        self.assertEqual(mapped["selection"], "automatic")

    def test_invalid_chat_answer_uses_bonus_evidence(self):
        from agents.response.chat import chat_reply
        from runtime.payroll import preprocess
        evidence = preprocess(self.context["current"], self.context["history"], "E1001")
        reply = chat_reply({"analysis": {"modelStatus": "invalid_response"}}, evidence, "how unusual bonus?")
        self.assertIn("Maya", reply)
        self.assertIn("comparable past bonuses", reply)
        self.assertNotIn("JSON", reply)
        self.assertNotIn("Retry Review", reply)
        self.assertNotIn("E1002", reply)
