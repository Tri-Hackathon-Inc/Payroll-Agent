"""Domain-aware template resolution, separate from persistence and execution."""
from template.interface import TemplateInterface
from pipelines.config import pipeline_settings


class CatalogTemplate(TemplateInterface):
    def configure(self, template_id, overrides):
        from template import services
        template = services.get_template(template_id)
        return template, services.merge_config(template["config"], overrides)


class TemplateConfig:
    def __init__(self, template=None):
        self.template = template if template is not None else CatalogTemplate()

    def resolve(self, domain_name, template_id, overrides, name):
        from template import services
        domain = services.get_domain(domain_name)
        template, effective = self.template.configure(template_id, overrides)
        if template["config"]["domain"] != domain.domain:
            raise services.InvalidInput("Template domain must match the selected domain.")
        services.validate_agent(name, effective, domain)
        services.validate_template_model(template, effective)
        effective["pipelines"] = pipeline_settings(effective)
        effective.setdefault("model_parameters", {})
        return domain, template, effective
