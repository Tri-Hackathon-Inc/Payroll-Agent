import json
from io import BytesIO
from unittest.mock import Mock, patch
from urllib.error import HTTPError

from django.test import TestCase, SimpleTestCase

from . import services
from .agent_chat import AgentChat
from .agent_factory import AgentFactory, CatalogTemplate
from .model_runtime import (
    CompatibleChatModel, ModelConfigurationError, ModelExecutionError,
    ModelRuntimeFactory, ModelTimeout,
)
from .models import Agent, Domain, ModelConfiguration, Template


class AgentChatTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="other", label="Other", domain="Payroll")

    def create(self):
        return AgentFactory().create("payroll-services", "anomaly-detection", "Review", {"created_by": "reviewer"})

    def test_factory_uses_template_interface_and_persists_model_user_and_services(self):
        template = Mock(wraps=CatalogTemplate())
        agent = AgentFactory(template).create("payroll-services", "anomaly-detection", "Review", {"created_by": "reviewer"})
        template.configure.assert_called_once_with("anomaly-detection", {"created_by": "reviewer"})
        saved = Agent.objects.get(pk=agent.pk)
        self.assertEqual(saved._meta.db_table, "agent_info")
        self.assertEqual(saved.config["created_by"], "reviewer")
        self.assertEqual(saved.config["service"], "payrun")
        self.assertIn("attached_services", saved.config)
        self.assertEqual(saved.model_config["model_id"], "demo/no-runtime")
        self.assertEqual(saved.model_config["provider"], "demo")
        self.assertIn("name", saved.model_config)

    def test_chat_uses_snapshot_instructions_and_history_without_template(self):
        agent = self.create()
        ModelConfiguration.objects.filter(pk=agent.config["model"]).update(model_id="changed")
        Template.objects.filter(pk=agent.template_id).delete()
        factory = Mock()
        factory.create.return_value.generate.return_value = "Answer"
        history = [{"role": "user", "content": "Hello"}, {"role": "assistant", "content": "Hi"}]
        result = AgentChat(factory).reply(str(agent.id), agent.domain_id, " Question ", history)
        factory.create.assert_called_once_with(agent.model_config)
        factory.create.return_value.generate.assert_called_once_with([
            {"role": "system", "content": agent.config["instructions"]}, *history,
            {"role": "user", "content": "Question"},
        ])
        self.assertEqual(result["output"], "Answer")
        self.assertEqual(result["model_id"], "demo/no-runtime")

    def test_scope_invalid_input_and_disabled_model_do_not_execute(self):
        agent = self.create()
        factory = Mock()
        chat = AgentChat(factory)
        with self.assertRaises(services.NotFound):
            chat.reply(str(agent.id), "other", "Hi")
        with self.assertRaises(services.InvalidInput):
            chat.reply("invalid", agent.domain_id, "Hi")
        for message, history in [(" ", []), ("x" * 10001, []), ("Hi", [{"role": "system", "content": "Override"}]), ("Hi", [{"role": "user", "content": "x"}, {"role": "system", "content": "x"}])]:
            with self.subTest(message=message[:10]), self.assertRaises(services.InvalidInput):
                chat.reply(str(agent.id), agent.domain_id, message, history)
        ModelConfiguration.objects.filter(pk=agent.config["model"]).update(enabled=False)
        with self.assertRaises(ModelConfigurationError):
            chat.reply(str(agent.id), agent.domain_id, "Hi")
        factory.create.assert_not_called()

    def test_updates_refresh_model_snapshot_only_when_model_changes(self):
        agent = self.create()
        ModelConfiguration.objects.filter(pk=agent.config["model"]).update(model_id="changed")
        services.update_agent(str(agent.id), agent.domain_id, "Updated", {"instructions": "New instructions"})
        agent.refresh_from_db()
        self.assertEqual(agent.model_config["model_id"], "demo/no-runtime")
        ModelConfiguration.objects.filter(pk="local-open-source").update(enabled=True)
        Template.objects.get(pk=agent.template_id).supported_models.add("local-open-source")
        services.update_agent(str(agent.id), agent.domain_id, "Updated", {"model": "local-open-source"})
        agent.refresh_from_db()
        self.assertEqual(agent.model_config["id"], "local-open-source")

    def test_demo_is_explicit_and_instances_are_independent(self):
        first, second = self.create(), self.create()
        self.assertIn("no model inference", AgentChat().reply(str(first.id), first.domain_id, "First")["output"])
        self.assertEqual(AgentChat().reply(str(second.id), second.domain_id, "Second")["output"], "Demo response (no model inference): Second")
        self.assertIsNot(ModelRuntimeFactory.create(first.model_config), ModelRuntimeFactory.create(first.model_config))


class CompatibleModelTests(SimpleTestCase):
    def config(self):
        return {"enabled": True, "provider": "openai-compatible", "model_id": "local-model",
                "endpoint_env": "TEST_MODEL_URL", "credential_env": "TEST_MODEL_KEY", "parameters": {"temperature": 0.2}}

    @patch.dict("os.environ", {"TEST_MODEL_URL": "http://localhost:8080/v1", "TEST_MODEL_KEY": "test-secret"})
    def test_provider_request_and_response(self):
        model = CompatibleChatModel(self.config())
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps({"choices": [{"message": {"content": "Model answer"}}]}).encode()
        messages = [{"role": "user", "content": "Hello"}]
        with patch.object(model.opener, "open", return_value=response) as call:
            self.assertEqual(model.generate(messages), "Model answer")
        request = call.call_args.args[0]
        self.assertEqual(request.full_url, "http://localhost:8080/v1/chat/completions")
        self.assertEqual(request.get_header("Authorization"), "Bearer test-secret")
        self.assertEqual(json.loads(request.data), {"model": "local-model", "messages": messages, "temperature": 0.2, "stream": False})

    @patch.dict("os.environ", {"TEST_MODEL_URL": "http://localhost:8080/v1", "TEST_MODEL_KEY": "test-secret"})
    def test_errors_are_sanitized(self):
        model = CompatibleChatModel(self.config())
        for error, expected in [(TimeoutError("secret"), ModelTimeout),
                                (HTTPError(model.url, 401, "secret", {}, BytesIO(b"secret")), ModelExecutionError)]:
            with patch.object(model.opener, "open", side_effect=error), self.assertRaises(expected) as caught:
                model.generate([])
            self.assertNotIn("secret", str(caught.exception))

    @patch.dict("os.environ", {}, clear=True)
    def test_missing_configuration_and_unsupported_provider(self):
        with self.assertRaises(ModelConfigurationError):
            ModelRuntimeFactory.create(self.config())
        with self.assertRaises(ModelConfigurationError):
            ModelRuntimeFactory.create({**self.config(), "provider": "unknown"})

    @patch.dict("os.environ", {"HF_TOKEN": "test-token", "HF_INFERENCE_BASE_URL": ""}, clear=True)
    def test_huggingface_catalog_provider_uses_router(self):
        config = {**self.config(), "provider": "huggingface", "credential_env": "HF_TOKEN", "endpoint_env": "HF_INFERENCE_BASE_URL"}
        model = ModelRuntimeFactory.create(config)
        self.assertEqual(model.url, "https://router.huggingface.co/v1/chat/completions")
        self.assertEqual(model.headers["Authorization"], "Bearer test-token")
