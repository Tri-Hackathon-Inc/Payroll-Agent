import json
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings
from django.test import TestCase, override_settings

from . import services
from .models import Agent, Business, Template
from .schema import schema


class AgentWorkflowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Business.objects.get_or_create(
            name="payroll-services",
            defaults={"label": "Payroll Services", "domain": "Payroll"},
        )
        Business.objects.create(
            name="other-payroll", label="Other Payroll", domain="Payroll"
        )
        Business.objects.create(name="hr-services", label="HR Services", domain="HR")

    def create(self, config=None, business="payroll-services"):
        return services.create_agent(
            business, "anomaly-detection", " Payroll review ", config or {}
        )

    def test_template_details_contain_form_defaults_and_options(self):
        template = services.get_template("anomaly-detection")
        self.assertEqual(template["config"]["model"], template["model_config"]["id"])
        self.assertTrue(template["model_options"])
        self.assertTrue(all(item["enabled"] for item in template["model_options"]))
        self.assertTrue(
            all(item["domain"] == "Payroll" for item in template["service_options"])
        )
        self.assertEqual(len(services.list_templates()), 4)

    def test_create_merges_defaults_and_persists_configuration(self):
        agent = self.create(
            {
                "instructions": "Review large payments.",
                "capabilities": {
                    "webhooks": {"enabled": True, "url": "https://example.com/events"}
                },
            }
        )
        saved = Agent.objects.get(pk=agent["id"])
        self.assertEqual(saved.name, "Payroll review")
        self.assertEqual(saved.config["instructions"], "Review large payments.")
        self.assertTrue(saved.config["capabilities"]["alerts"]["enabled"])
        self.assertEqual(
            saved.config, services.get_business_agents("payroll-services")[0]["config"]
        )
        self.assertEqual(saved.template_version, 1)
        self.assertNotEqual(
            saved.config, Template.objects.get(pk="anomaly-detection").config
        )

    def test_update_preserves_prior_overrides_and_template(self):
        agent = self.create({"instructions": "Custom instructions"})
        updated = services.update_agent(
            agent["id"],
            "payroll-services",
            "Updated",
            {"capabilities": {"alerts": {"severity": "critical"}}},
        )
        self.assertEqual(updated["id"], agent["id"])
        self.assertEqual(updated["config"]["instructions"], "Custom instructions")
        self.assertTrue(updated["config"]["capabilities"]["alerts"]["enabled"])
        self.assertEqual(
            updated["config"]["capabilities"]["alerts"]["severity"], "critical"
        )
        self.assertEqual(updated["created_at"], agent["created_at"])
        self.assertEqual(Agent.objects.count(), 1)

    def test_business_filter_and_scoped_update(self):
        agent = self.create()
        self.assertEqual(services.get_business_agents("other-payroll"), [])
        with self.assertRaises(services.NotFound):
            services.update_agent(agent["id"], "other-payroll", "Wrong business", {})
        self.assertEqual(Agent.objects.get(pk=agent["id"]).name, "Payroll review")

    def test_invalid_config_does_not_create_agents(self):
        for config in [
            [],
            {"model": "missing"},
            {"model": "local-open-source"},
            {"attached_services": ["missing"]},
            {"unknown": True},
            {"capabilities": {"webhooks": {"enabled": True}}},
            {"capabilities": {"webhooks": {"url": "http://example.com"}}},
        ]:
            with self.subTest(config=config), self.assertRaises(services.InvalidInput):
                services.create_agent(
                    "payroll-services", "anomaly-detection", "Agent", config
                )
        self.assertEqual(Agent.objects.count(), 0)

    def test_invalid_update_is_atomic(self):
        agent = self.create()
        with self.assertRaises(services.InvalidInput):
            services.update_agent(
                agent["id"], "payroll-services", "Changed", {"model": "missing"}
            )
        saved = Agent.objects.get(pk=agent["id"])
        self.assertEqual(saved.name, agent["name"])
        self.assertEqual(saved.config, agent["config"])

    def test_missing_resources_and_business_domain(self):
        with self.assertRaises(services.NotFound):
            services.get_business_agents("missing")
        with self.assertRaises(services.TemplateNotFound):
            services.create_agent("payroll-services", "missing", "Agent", {})
        with self.assertRaises(services.InvalidInput):
            self.create(business="hr-services")
        with self.assertRaises(services.InvalidInput):
            services.update_agent("bad-id", "payroll-services", "Agent", {})
        with self.assertRaises(services.NotFound):
            services.update_agent(
                "00000000-0000-0000-0000-000000000000", "payroll-services", "Agent", {}
            )

    def test_sync_keeps_saved_agent_snapshot_when_template_changes_or_is_removed(self):
        agent = self.create()
        with TemporaryDirectory() as directory:
            root = Path(directory) / "templates"
            shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
            path = root / "anomaly-detection.json"
            template = json.loads(path.read_text())
            template["version"] = 2
            template["config"]["instructions"] = "New defaults"
            path.write_text(json.dumps(template))
            with override_settings(TEMPLATE_CONFIG_DIR=root):
                services.sync_templates()
                self.assertEqual(
                    services.get_business_agents("payroll-services")[0]["config"],
                    agent["config"],
                )
                path.unlink()
                services.sync_templates()
        saved = Agent.objects.get(pk=agent["id"])
        self.assertEqual(saved.template_version, 1)
        self.assertEqual(saved.config, agent["config"])

    def test_strawberry_exposes_only_six_operations_and_supports_mutations(self):
        graphql_schema = schema._schema
        self.assertEqual(
            set(graphql_schema.query_type.fields),
            {"templates", "template", "businesses", "businessAgents"},
        )
        self.assertEqual(
            set(graphql_schema.mutation_type.fields), {"createAgent", "updateAgent"}
        )
        result = schema.execute_sync(
            """mutation {
          createAgent(input: {businessName: "payroll-services", templateId: "summarizer",
                             name: "Summary", config: {instructions: "Summarize payruns"}}) {
            id businessName templateId config
          }
        }"""
        )
        self.assertIsNone(result.errors)
        agent = result.data["createAgent"]
        result = schema.execute_sync(
            """mutation Update($input: UpdateAgentInput!) {
          updateAgent(input: $input) { id name config }
        }""",
            variable_values={
                "input": {
                    "id": agent["id"],
                    "businessName": "payroll-services",
                    "name": "Updated summary",
                    "config": {"questions": []},
                }
            },
        )
        self.assertIsNone(result.errors)
        self.assertEqual(result.data["updateAgent"]["config"]["questions"], [])
        self.assertEqual(result.data["updateAgent"]["name"], "Updated summary")

    def test_no_django_http_routes(self):
        self.assertFalse(hasattr(settings, "ROOT_URLCONF"))
