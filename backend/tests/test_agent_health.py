from tests.access_fixtures import grant_read
import os
from unittest.mock import patch
from django.test import TestCase
from agent_factory.factory import AgentFactory
from agents.health import agent_health
from storage.models import Domain
from template import services


@patch.dict(os.environ, STUDIO_ADMIN_KEY="")
class AgentHealthTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.get_or_create(name="other", defaults={"label": "Other", "domain": "Payroll"})

    def setUp(self):
        self.agent = AgentFactory().create("payroll-services", "general-query", "Chat", {"model": "poc-demo"})

        grant_read(self.agent)

    def test_live_uses_safe_query_without_inference(self):
        with patch("agents.health.request_json", return_value={"data": {"__typename": "Query"}}) as request, patch("model.model.Model.generate") as generate:
            result = agent_health({"domainName": "payroll-services"}, {})
        self.assertEqual(result["items"][0]["status"], "live")
        self.assertEqual(request.call_args.args[1], {"query": "query AgentHealth { __typename }"})
        generate.assert_not_called()

    def test_service_failure_is_red_and_does_not_leak_error(self):
        with patch("agents.health.request_json", side_effect=ValueError("SECRET endpoint")):
            result = agent_health({"domainName": "payroll-services"}, {})
        self.assertEqual(result["items"][0]["status"], "not_connected")
        self.assertNotIn("SECRET", str(result))

    def test_domain_isolation_and_shared_service_probe(self):
        AgentFactory().create("other", "general-query", "Other", {"model": "poc-demo"})
        grant_read(AgentFactory().create("payroll-services", "general-query", "Second", {"model": "poc-demo"}))
        with patch("agents.health.probe_service", return_value=(True, "Connected")) as probe:
            result = agent_health({"domainName": "payroll-services"}, {})
        self.assertEqual(len(result["items"]), 2)
        probe.assert_called_once()

    def test_failed_graphql_response_is_not_live(self):
        with patch("agents.health.request_json", return_value={"errors": [{"message": "unavailable"}]}):
            result = agent_health({"domainName": "payroll-services", "agentId": str(self.agent.pk)}, {})
        self.assertEqual(result["items"][0]["status"], "not_connected")
