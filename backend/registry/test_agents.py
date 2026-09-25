import json
import shutil
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.conf import settings
from django.core.management import CommandError, call_command
from django.test import TestCase, override_settings

from . import services
from .models import Agent, Domain, Template


class AgentWorkflowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(
            name="payroll-services",
            defaults={"label": "Payroll Services", "domain": "Payroll"},
        )
        Domain.objects.create(
            name="other-payroll", label="Other Payroll", domain="Payroll"
        )
        Domain.objects.create(name="hr-services", label="HR Services", domain="HR")

    def create(self, config=None, domain="payroll-services"):
        return services.create_agent(
            domain, "anomaly-detection", " Payroll review ", config or {}
        )

    def test_domain_provisioning_is_repeatable_and_preserves_domain(self):
        output = StringIO()
        for _ in range(2):
            call_command(
                "create_domain",
                "new-payroll",
                label="New Payroll",
                domain="Payroll",
                stdout=output,
            )
        self.assertEqual(Domain.objects.filter(name="new-payroll").count(), 1)
        self.assertIn("Created domain", output.getvalue())
        self.assertIn("Existing domain", output.getvalue())
        with self.assertRaises(CommandError):
            call_command(
                "create_domain", "new-payroll", label="HR", domain="HR", stdout=output
            )
        self.assertEqual(Domain.objects.get(pk="new-payroll").domain, "Payroll")

    def test_domain_provisioning_rejects_invalid_slug(self):
        with self.assertRaises(CommandError):
            call_command(
                "create_domain", "invalid domain", label="Invalid", domain="Payroll"
            )
        self.assertFalse(Domain.objects.filter(name="invalid domain").exists())

    def test_template_details_contain_form_defaults_and_options(self):
        template = services.get_template("anomaly-detection")
        self.assertEqual(template["config"]["model"], "llama-3-3-70b")
        self.assertEqual(template["model_config"]["provider"], "huggingface")
        self.assertEqual(template["config"]["model"], template["model_config"]["id"])
        self.assertTrue(template["model_options"])
        self.assertTrue(all(item["enabled"] for item in template["model_options"]))
        self.assertTrue(
            all(item["domain"] == "Payroll" for item in template["service_options"])
        )

    def test_list_templates_filters_primary_service(self):
        Template.objects.filter(pk="failure-investigation").update(service_id="diagnostics")
        templates = services.list_templates("payrun")
        self.assertEqual(len(templates), 3)
        self.assertNotIn("failure-investigation", [item["id"] for item in templates])
        self.assertTrue(all(item["config"]["service"] == "payrun" for item in templates))
        self.assertEqual([item["id"] for item in services.list_templates("diagnostics")], ["failure-investigation"])
        self.assertEqual(services.list_templates("payrun-history"), [])
        with self.assertRaises(services.NotFound):
            services.list_templates("missing")
        for value in ("", "   ", None):
            with self.subTest(value=value), self.assertRaises(services.InvalidInput):
                services.list_templates(value)

    def test_template_list_carries_the_same_options_as_details(self):
        for listed in services.get_domain_agents_templates("payroll-services"):
            detail = services.get_template(listed["id"])
            self.assertEqual(listed["model_options"], detail["model_options"])
            self.assertEqual(listed["service_options"], detail["service_options"])
            self.assertTrue(listed["service_options"])

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
            saved.config, services.get_domain_agents("payroll-services")[0]["config"]
        )
        self.assertEqual(saved.template_version, Template.objects.get(pk="anomaly-detection").version)
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

    def test_domain_filter_and_scoped_update(self):
        agent = self.create()
        self.assertEqual(services.get_domain_agents("other-payroll"), [])
        with self.assertRaises(services.NotFound):
            services.update_agent(agent["id"], "other-payroll", "Wrong domain", {})
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

    def test_missing_resources_and_domain_domain(self):
        with self.assertRaises(services.NotFound):
            services.get_domain_agents("missing")
        with self.assertRaises(services.TemplateNotFound):
            services.create_agent("payroll-services", "missing", "Agent", {})
        with self.assertRaises(services.InvalidInput):
            self.create(domain="hr-services")
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
            template["version"] += 1
            template["config"]["instructions"] = "New defaults"
            path.write_text(json.dumps(template))
            with override_settings(TEMPLATE_CONFIG_DIR=root):
                services.sync_templates()
                self.assertEqual(
                    services.get_domain_agents("payroll-services")[0]["config"],
                    agent["config"],
                )
                path.unlink()
                services.sync_templates()
        saved = Agent.objects.get(pk=agent["id"])
        self.assertEqual(saved.template_version, agent["template_version"])
        self.assertEqual(saved.config, agent["config"])

    def test_model_details_are_synced_and_returned(self):
        models = {item["id"]: item for item in services.list_model_configs()}
        self.assertEqual(models["qwen-2-5-72b"]["details"]["license"], "open-source")
        self.assertEqual(models["mistral-large"]["details"]["license"], "commercial")
        options = services.get_template("summarizer")["model_options"]
        self.assertIn("qwen-2-5-72b", [item["id"] for item in options])

    def test_invalid_model_details_are_rejected(self):
        from .catalog import CatalogError, load_catalog

        for details in ({"license": "free"}, {"strengths": "fast"}, []):
            with TemporaryDirectory() as directory:
                root = Path(directory) / "templates"
                shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
                path = root / "Model_config" / "poc-demo.json"
                model = json.loads(path.read_text())
                model["details"] = details
                path.write_text(json.dumps(model))
                with override_settings(TEMPLATE_CONFIG_DIR=root):
                    with self.assertRaises(CatalogError):
                        load_catalog()

    def test_templates_offer_only_their_supported_models(self):
        offered = {
            item["id"]: [model["id"] for model in item["model_options"]]
            for item in services.get_domain_agents_templates("payroll-services")
        }
        self.assertEqual(
            offered["anomaly-detection"],
            ["bedrock-claude", "llama-3-3-70b", "mistral-large", "poc-demo"],
        )
        self.assertNotIn("qwen-2-5-72b", offered["anomaly-detection"])
        self.assertIn("qwen-2-5-72b", offered["summarizer"])

    def test_agents_cannot_use_a_model_the_template_does_not_offer(self):
        with self.assertRaisesMessage(services.InvalidInput, "not offered by this template"):
            self.create({"model": "qwen-2-5-72b"})
        agent = self.create({"model": "llama-3-3-70b"})
        self.assertEqual(agent["config"]["model"], "llama-3-3-70b")
        with self.assertRaisesMessage(services.InvalidInput, "not offered by this template"):
            services.update_agent(agent["id"], "payroll-services", "Payroll review", {"model": "qwen-2-5-72b"})

    def test_published_benchmarks_have_sources(self):
        qwen = {item["id"]: item for item in services.list_model_configs()}["qwen-2-5-72b"]
        self.assertTrue(qwen["details"]["benchmarks"])
        self.assertTrue(all(item["source"].startswith("https://") for item in qwen["details"]["benchmarks"]))

    def test_invalid_template_models_and_benchmarks_are_rejected(self):
        from .catalog import CatalogError, load_catalog

        cases = [
            ("anomaly-detection.json", "models", ["no-such-model"]),
            ("anomaly-detection.json", "models", ["poc-demo"]),  # default Llama missing
            ("Model_config/qwen-2-5-72b.json", "benchmarks", [{"name": "MMLU", "score": 1}]),
            ("Model_config/qwen-2-5-72b.json", "benchmarks", [{"name": "MMLU", "score": "high", "source": "https://x.org"}]),
        ]
        for file, field, value in cases:
            with TemporaryDirectory() as directory:
                root = Path(directory) / "templates"
                shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
                path = root / file
                data = json.loads(path.read_text())
                (data["details"] if field == "benchmarks" else data)[field] = value
                path.write_text(json.dumps(data))
                with override_settings(TEMPLATE_CONFIG_DIR=root):
                    with self.assertRaises(CatalogError):
                        load_catalog()

    def test_no_django_http_routes(self):
        self.assertFalse(hasattr(settings, "ROOT_URLCONF"))

    def test_domain_templates_are_templates_and_scoped(self):
        self.assertEqual(len(services.get_domain_agents_templates("payroll-services")), 4)
        self.assertEqual(services.get_domain_agents_templates("hr-services"), [])
        self.assertIn("anomaly-detection", [t["id"] for t in services.get_domain_agents_templates("payroll-services")])
        with self.assertRaises(services.NotFound):
            services.get_domain_agents_templates("missing")

    def test_registry_filters_saved_primary_service_and_domain(self):
        first = self.create()
        other = self.create(domain="other-payroll")
        diagnostic = self.create(config={"service": "diagnostics"})
        self.assertEqual([a["id"] for a in services.get_service_agent_registry("diagnostics")], [diagnostic["id"]])
        self.assertEqual([a["id"] for a in services.get_service_agent_registry(first["config"]["service"], "payroll-services")], [first["id"]])
        self.assertIn(other["id"], [a["id"] for a in services.get_service_agent_registry(first["config"]["service"])])
        self.assertEqual(services.get_service_agent_registry("payrun-history"), [])
        with self.assertRaises(services.NotFound):
            services.get_service_agent_registry("missing")
        with self.assertRaises(services.NotFound):
            services.get_service_agent_registry(domain_name="missing")
