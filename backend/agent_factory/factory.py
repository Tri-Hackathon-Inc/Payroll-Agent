"""Build persisted agents from template defaults and validated UI configuration."""

from uuid import UUID
from django.db import transaction
from agent_factory.interface import AgentFactoryInterface
from storage.models import Agent, ModelConfiguration
from template.config import TemplateConfig, TemplateInterface, CatalogTemplate


def model_snapshot(config):
    from template.services import model_data

    snapshot = model_data(ModelConfiguration.objects.get(pk=config["model"], enabled=True))
    snapshot["parameters"] = {**snapshot.get("parameters", {}), **config.get("model_parameters", {})}
    return snapshot


class AgentFactory(AgentFactoryInterface):
    def __init__(self, template=None):
        self.template_config = TemplateConfig(template)

    @transaction.atomic
    def create(self, domain_name, template_id, name, config):
        domain, template, effective = self.template_config.resolve(domain_name, template_id, config, name)
        return Agent.objects.create(
            domain=domain,
            name=name.strip(),
            template_id=template["id"],
            template_version=template["version"],
            config=effective,
            model_config=model_snapshot(effective),
        )

    def load(self, domain_name, agent_id, runtime_factory=None):
        from template import services
        from agents.agent import ConfiguredAgent
        domain = services.get_domain(domain_name)
        try:
            identity = UUID(str(agent_id))
        except (ValueError, TypeError) as error:
            raise services.InvalidInput("agent_id must be a valid UUID.") from error
        try:
            saved = Agent.objects.get(pk=identity, domain=domain)
        except Agent.DoesNotExist as error:
            raise services.NotFound("Agent not found in this domain.") from error
        data = services.agent_data(saved)
        if not ModelConfiguration.objects.filter(pk=saved.config["model"], enabled=True).exists():
            data["model_config"] = {**data["model_config"], "enabled": False}
        from agents.anomaly_detection.components import is_anomaly_agent
        if is_anomaly_agent(data):
            from agents.anomaly_detection.agent import AnomalyDetectionAgent
            return AnomalyDetectionAgent(data, runtime_factory=runtime_factory)
        return ConfiguredAgent(data, runtime_factory=runtime_factory)
