"""Build persisted agents from template defaults and validated UI configuration."""

from abc import ABC, abstractmethod

from django.db import transaction

from .models import Agent, ModelConfiguration


class TemplateInterface(ABC):
    @abstractmethod
    def configure(self, template_id, overrides):
        """Return template metadata and the effective agent configuration."""


class CatalogTemplate(TemplateInterface):
    def configure(self, template_id, overrides):
        from . import services

        template = services.get_template(template_id)
        return template, services.merge_config(template["config"], overrides)


def model_snapshot(config):
    from .services import model_data

    return model_data(ModelConfiguration.objects.get(pk=config["model"], enabled=True))


class AgentFactory:
    def __init__(self, template=None):
        self.template = template if template is not None else CatalogTemplate()

    @transaction.atomic
    def create(self, domain_name, template_id, name, config):
        from . import services

        domain = services.get_domain(domain_name)
        template, effective = self.template.configure(template_id, config)
        if template["config"]["domain"] != domain.domain:
            raise services.InvalidInput("Template domain must match the selected domain.")
        services.validate_agent(name, effective, domain)
        return Agent.objects.create(
            domain=domain,
            name=name.strip(),
            template_id=template["id"],
            template_version=template["version"],
            config=effective,
            model_config=model_snapshot(effective),
        )
