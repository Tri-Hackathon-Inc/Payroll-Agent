"""Contract composition and persisted configuration, without external providers."""
from copy import deepcopy
from unittest.mock import Mock

from django.test import TestCase, SimpleTestCase
from agents.interface import AgentInterface
from template import services
from agents.agent import ConfiguredAgent
from agent_factory.factory import AgentFactory
from model.model import Model
from storage.models import Domain, Agent
from pipelines.config import pipeline_settings
from pipelines.payroll import PayrollQueryPipeline, PayrollResponsePipeline
from agents.question.logic import catalogue, question_flow
from tests.test_runtime import agent, fixture


class FactoryConfigurationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="interfaces-test", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="interfaces-other", label="Other", domain="Payroll")

    def create(self, **config):
        return AgentFactory().create("interfaces-test", "general-query", "Configured", {"model": "poc-demo", **config})

    def test_factory_persists_settings_and_rehydrates_an_independent_agent(self):
        saved = self.create(pipelines={"query": {"enabled": False}}, model_parameters={"temperature": 0.4})
        saved.refresh_from_db()
        self.assertEqual(saved.model_config["parameters"]["temperature"], 0.4)
        self.assertEqual(saved.config["pipelines"]["query"]["candidateLimit"], 3)
        loaded = AgentFactory().load("interfaces-test", saved.id)
        self.assertIsInstance(loaded, AgentInterface)
        self.assertIn("no model inference", loaded.respond("Hello", {}, {})["answer"]["reply"])
        loaded.definition["config"]["instructions"] = "Changed in memory"
        self.assertNotEqual(Agent.objects.get(pk=saved.id).config["instructions"], "Changed in memory")
        with self.assertRaises(services.NotFound):
            AgentFactory().load("interfaces-other", saved.id)

    def test_invalid_pipeline_or_model_settings_never_persist(self):
        for config in ({"pipelines": {"query": {"candidateLimit": True}}},
                       {"pipelines": {"query": {"retrievalLimit": 0}}},
                       {"pipelines": {"response": {"skipValidation": True}}},
                       {"model_parameters": {"api_key": "forbidden"}},
                       {"model_parameters": {"max_tokens": 1.5}}):
            with self.subTest(config=config), self.assertRaises(services.InvalidInput):
                self.create(**config)
        self.assertEqual(Agent.objects.count(), 0)

    def test_parameter_update_refreshes_saved_model(self):
        saved = self.create(model_parameters={"temperature": 0.4})
        services.update_agent(saved.id, saved.domain_id, saved.name, {"model_parameters": {"temperature": 0.8}})
        saved.refresh_from_db()
        self.assertEqual(saved.model_config["parameters"]["temperature"], 0.8)


class PipelineCompositionTests(SimpleTestCase):
    def definition(self):
        definition = agent()
        definition["domain_name"] = "domain"
        definition["config"]["instructions"] = "Answer briefly."
        return definition

    def test_question_configuration_controls_catalogue_count_and_expiry(self):
        definition = self.definition()
        definition["config"]["pipelines"] = {"query": {"includeSharedQuestions": False, "candidateLimit": 1, "confirmationTtlSeconds": 60}}
        questions = catalogue(definition, "domain")
        self.assertEqual(len(questions), 1)
        store = Mock()
        store.search.return_value = [{**questions[0], "distance": 0.2}]
        answer = Mock()
        result = question_flow(definition, "domain", "Why less?", None, {"scopeHash": "scope"}, answer, store, now=1000)
        self.assertEqual(result["pendingQuestion"]["expiresAt"], 61000)
        self.assertEqual(store.search.call_args.args[2], 1)
        answer.assert_not_called()

    def test_optional_query_pipeline_skips_payroll_dependencies(self):
        definition = self.definition()
        definition["config"]["pipelines"] = {"query": {"enabled": False}}
        model, query, loader = Mock(), Mock(), Mock()
        model.generate.return_value = "  A brief answer.  "
        configured = ConfiguredAgent(definition, model=model, query_pipeline=query)
        result = configured.respond("Hello", {"payrunId": "p"}, {}, load=loader)
        self.assertEqual(result["answer"]["reply"], "A brief answer.")
        query.prepare.assert_not_called()
        loader.assert_not_called()

    def test_injected_stages_execute_in_order_and_grounding_remains_mandatory(self):
        definition = self.definition()
        definition["config"]["pipelines"] = {"query": {"questionMatching": False}, "response": {"includeDetails": False}}
        context, order = fixture(), []
        store = Mock()
        store.search.return_value = []
        query = Mock()
        def prepare(*args, **kwargs):
            order.append("query")
            return PayrollQueryPipeline().prepare(*args, load=kwargs["load"], store=store)
        query.prepare.side_effect = prepare
        model = Mock()
        def generate(*args, **kwargs):
            order.append("model")
            return '{"answer":"Unverified","sourceIds":["invented"],"findings":[]}'
        model.generate.side_effect = generate
        response = Mock()
        def process(*args):
            order.append("response")
            return PayrollResponsePipeline(pipeline_settings(definition["config"])["response"]).process(*args)
        response.process.side_effect = process
        configured = ConfiguredAgent(definition, model=model, query_pipeline=query, response_pipeline=response)
        result = configured.respond("Compare net pay", {"payrunId": context["current"]["id"], "employeeId": context["current"]["lines"][0]["employeeId"]}, {}, load=lambda _: context)["answer"]
        self.assertEqual(order, ["query", "model", "response"])
        self.assertEqual(result["analysis"]["modelStatus"], "invalid_response")
        self.assertNotIn("details", result["analysis"])
        self.assertNotEqual(result["reply"], "Unverified")
        self.assertEqual(result["retrieval"]["intent"]["intent"], "direct_question")

    def test_model_response_format_does_not_mutate_saved_configuration(self):
        configuration = {"parameters": {"temperature": 0.2}}
        original = deepcopy(configuration)
        factory = Mock()
        factory.create.return_value.generate.return_value = "answer"
        model = Model(configuration, factory)
        model.generate([], response_format={"type": "json_object"})
        self.assertEqual(factory.create.call_args.args[0]["parameters"]["response_format"], {"type": "json_object"})
        self.assertEqual(configuration, original)
        model.generate([])
        self.assertEqual(factory.create.call_args.args[0], original)
