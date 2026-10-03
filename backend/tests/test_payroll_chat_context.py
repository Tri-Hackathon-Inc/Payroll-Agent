from unittest.mock import patch
from django.test import TestCase
from agent_factory.factory import AgentFactory
from agents.question.payroll_context import payroll_chat_context
from storage.models import Domain, AgentContextPermission, AgentMessage
from template import services
from tests.test_runtime import fixture


class PayrollChatContextTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})

    def setUp(self):
        self.agent = AgentFactory().create("payroll-services", "anomaly-detection", "AD", {"model": "poc-demo", "page": "payrun"})
        self.chat = AgentFactory().create("payroll-services", "general-query", "Chat reader", {"model":"poc-demo","page":"payrun"})
        AgentContextPermission.objects.create(reader=self.chat,source=self.agent)
        self.runtime = AgentFactory().load("payroll-services", str(self.agent.pk))
        self.context = fixture()
        _, self.case = self.runtime.check(self.context)

    def read(self, employee=None, run=None, domain="payroll-services"):
        return payroll_chat_context(domain, run or self.context["current"], employee, self.agent.config["service"], reader_id=str(self.chat.pk))

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

    def test_ungranted_context_is_not_read_and_revocation_is_immediate(self):
        self.assertEqual(self.read()["status"],"decision")
        AgentContextPermission.objects.all().delete()
        self.assertEqual(self.read()["status"],"unavailable")
        self.assertEqual(self.read()["incidentReports"],[])

    def test_incident_context_requires_own_directional_grant_and_matching_scope(self):
        incident = AgentFactory().create("payroll-services","incident-report","Reports",{"model":"poc-demo","page":"payrun"})
        AgentMessage.objects.create(id="c"*64,domain_id="payroll-services",sender_id=self.agent.pk,recipient_id=incident.pk,service=self.agent.config["service"],capability="incident-report",source_reference=self.case.pk,source_version=self.case.payrun_version,requested_by="a"*64,status="completed",result={"reply":"Verify the approved bonus.","incident":{"id":"INC-test","payrunId":self.case.payrun_id,"title":"Bonus review","evidence":[]}})
        self.assertEqual(self.read()["incidentReports"],[])
        AgentContextPermission.objects.create(reader=self.chat,source=incident)
        self.assertEqual(self.read()["incidentReports"][0]["reportId"],"INC-test")
        self.assertEqual(self.read("E1001")["incidentReports"],[])
        self.assertEqual(self.read(run={**self.context["current"],"version":999})["incidentReports"],[])
        AgentContextPermission.objects.filter(reader=self.chat,source=self.agent).delete()
        self.assertEqual(self.read()["status"],"unavailable")
        self.assertEqual(len(self.read()["incidentReports"]),1)

    def test_context_only_answer_uses_saved_case_without_loading_payroll(self):
        import json
        from unittest.mock import Mock
        from agents.question.context_answer import answer_context
        model = Mock()
        model.generate.return_value = json.dumps({"answer":"Verify the saved flagged payments.", "sourceIds":[str(self.case.pk)]})
        with patch("runtime.payroll.load_context", side_effect=AssertionError("No payroll access")):
            result = answer_context(services.agent_data(self.chat),
                                    {"payrunId":self.case.payrun_id}, "What should I review?", model)
        self.assertEqual(result["analysis"]["modelStatus"], "completed")
        self.assertIn("saved AD check", result["reply"])
        self.assertIn('"agentContext"', model.generate.call_args.args[0][1]["content"])
        model.reset_mock()
        result = answer_context(services.agent_data(self.chat),
                                {"payrunId":self.case.payrun_id,"employeeId":"E1001"}, "Why?", model)
        self.assertIn("No saved AD result", result["reply"])
        model.generate.assert_not_called()
        AgentContextPermission.objects.filter(reader=self.chat).delete()
        from runtime.common import RuntimeFailure
        with self.assertRaises(RuntimeFailure):
            answer_context(services.agent_data(self.chat), {"payrunId":self.case.payrun_id}, "Why?", model)

    def test_context_only_rejects_unknown_citations(self):
        from unittest.mock import Mock
        from agents.question.context_answer import answer_context
        model = Mock()
        model.generate.return_value = '{"answer":"Unsupported response","sourceIds":["unknown"]}'
        result = answer_context(services.agent_data(self.chat), {"payrunId":self.case.payrun_id}, "Why?", model)
        self.assertEqual(result["analysis"]["modelStatus"], "unavailable")
        self.assertNotIn("Unsupported response", result["reply"])

    def test_context_chat_health_does_not_probe_payroll(self):
        import os
        from agents.health import agent_health
        services.update_agent(str(self.chat.pk), "payroll-services", self.chat.name, {"model":"llama-3-3-70b"})
        with patch.dict(os.environ, HF_TOKEN="test", STUDIO_ADMIN_KEY=""), patch("agents.health.probe_service") as probe:
            result = agent_health({"domainName":"payroll-services","agentId":str(self.chat.pk)}, {})
        self.assertEqual(result["items"][0]["status"], "live")
        self.assertIn("saved AD context", result["items"][0]["reason"])
        probe.assert_not_called()

    def test_execution_context_path_never_loads_payroll(self):
        import json
        import os
        from runtime.execution import execute
        def conversation(options, run):
            return run({"context":options["context"],"history":[]})["answer"]
        def search(questions, query, limit):
            return [{**questions[0],"distance":0.1}]
        with patch.dict(os.environ, STUDIO_ADMIN_KEY=""), patch("runtime.execution.with_conversation", side_effect=conversation), patch("agents.question.logic.VectorStore") as store, patch("model.model.Model.generate", return_value=json.dumps({"answer":"Check the saved findings.", "sourceIds":[str(self.case.pk)]})), patch("runtime.execution.load_context",side_effect=AssertionError("Payroll API must not run")), patch("runtime.execution.raise_incidents",side_effect=AssertionError("No automatic incident")):
            store.return_value.search.side_effect=search
            result=execute({"domainName":"payroll-services","agentId":str(self.chat.pk),"question":"What needs review?",
                            "context":{"page":"payrun","payrunId":self.case.payrun_id}}, {"x-session-owner":"a"*64})
        self.assertEqual(result["answeredBy"], "agent_context")
        self.assertEqual(result["analysis"]["modelStatus"], "completed")
