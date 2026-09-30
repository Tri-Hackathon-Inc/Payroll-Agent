"""Template, domain, and agent operations shared by all API adapters."""

from copy import deepcopy
from uuid import UUID

from django.db import transaction

from template.catalog import load_catalog
from template.configuration import validate_config
from storage.models import (Agent, Domain, ModelConfiguration, ServiceDefinition,
                     Template)


class NotFound(Exception):
    pass


class TemplateNotFound(NotFound):
    pass


class InvalidInput(ValueError):
    pass


@transaction.atomic
def sync_templates():
    # Validate all source files before making any database changes.
    catalog = load_catalog()
    for entry in catalog["model_configs"]:
        values = {
            key: entry[key]
            for key in ("name", "provider", "model_id", "enabled", "parameters")
        }
        values.update(
            endpoint_env=entry.get("endpoint_env", ""),
            credential_env=entry.get("credential_env", ""),
            details=entry.get("details", {}),
        )
        ModelConfiguration.objects.update_or_create(id=entry["id"], defaults=values)
    for entry in catalog["services"]:
        values = {
            key: entry[key]
            for key in ("name", "domain", "enabled", "base_url_env", "method", "path")
        }
        ServiceDefinition.objects.update_or_create(id=entry["id"], defaults=values)
    for entry in catalog["templates"]:
        config = entry["config"]
        template, _ = Template.objects.update_or_create(
            id=entry["id"],
            defaults={
                "name": entry["name"],
                "description": entry["description"],
                "version": entry["version"],
                "config": config,
                "default_model_id": config["model"],
                "service_id": config["service"],
            },
        )
        template.attached_services.set(config["attached_services"])
        template.supported_models.set(entry.get("models", []))
    # The database is a projection of the source files, including removals.
    Template.objects.exclude(
        id__in=[item["id"] for item in catalog["templates"]]
    ).delete()
    ModelConfiguration.objects.exclude(
        id__in=[item["id"] for item in catalog["model_configs"]]
    ).delete()
    ServiceDefinition.objects.exclude(
        id__in=[item["id"] for item in catalog["services"]]
    ).delete()
    return {key: len(items) for key, items in catalog.items()}


def model_data(model):
    return {
        key: getattr(model, key)
        for key in (
            "id",
            "name",
            "provider",
            "model_id",
            "enabled",
            "endpoint_env",
            "credential_env",
            "parameters",
            "details",
        )
    }


def service_data(service):
    return {
        key: getattr(service, key)
        for key in ("id", "name", "domain", "enabled", "base_url_env", "method", "path")
    }


def template_data(template):
    attached = {item.id: item for item in template.attached_services.all()}
    return {
        "id": template.id,
        "name": template.name,
        "description": template.description,
        "version": template.version,
        "config": template.config,
        "model_config": model_data(template.default_model),
        "service": service_data(template.service),
        "attached_services": [
            service_data(attached[key]) for key in template.config["attached_services"]
        ],
    }


def template_queryset():
    return Template.objects.select_related("default_model", "service").prefetch_related(
        "attached_services", "supported_models"
    )


def with_options(template, data, models, service_list):
    # Form options travel with the template, not separate public APIs.
    supported = {item.id for item in template.supported_models.all()}
    data["model_options"] = [
        item for item in models
        if item["enabled"] and (not supported or item["id"] in supported)
    ]
    data["service_options"] = [
        item
        for item in service_list
        if item["enabled"] and item["domain"] == data["config"]["domain"]
    ]
    return data


def templates_with_options(queryset):
    models, service_list = list_model_configs(), list_services()
    return [
        with_options(template, template_data(template), models, service_list)
        for template in queryset
    ]


def list_templates(service_name):
    if not isinstance(service_name, str) or not service_name.strip():
        raise InvalidInput("service_name is required.")
    if not ServiceDefinition.objects.filter(pk=service_name).exists():
        raise NotFound(f"Service {service_name!r} not found.")
    return templates_with_options(template_queryset().filter(service_id=service_name))


def get_template(template_id):
    try:
        template = template_queryset().get(pk=template_id)
        return with_options(
            template, template_data(template), list_model_configs(), list_services()
        )
    except Template.DoesNotExist as error:
        raise TemplateNotFound(f"Template {template_id!r} not found.") from error


def list_model_configs():
    return [model_data(model) for model in ModelConfiguration.objects.order_by("id")]


def list_services():
    return [
        service_data(service) for service in ServiceDefinition.objects.order_by("id")
    ]


def list_domains():
    return list(Domain.objects.values("name", "label", "domain"))


def get_domain(name):
    try:
        return Domain.objects.get(pk=name)
    except Domain.DoesNotExist as error:
        raise NotFound(f"Domain {name!r} not found.") from error


def agent_data(agent):
    return {
        "id": str(agent.id),
        "name": agent.name,
        "domain_name": agent.domain_id,
        "template_id": agent.template_id,
        "template_version": agent.template_version,
        "config": agent.config,
        "created_at": agent.created_at.isoformat(),
        "updated_at": agent.updated_at.isoformat(),
        "model_config": agent.model_config,
    }


def get_domain_agents(domain_name):
    domain = get_domain(domain_name)
    return [agent_data(agent) for agent in domain.agents.all()]


def merge_config(defaults, overrides):
    if not isinstance(overrides, dict):
        raise InvalidInput("config must be an object.")
    result = deepcopy(defaults)
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = merge_config(result[key], value)
        else:
            result[key] = deepcopy(value)
    return result


def validate_agent(name, config, domain):
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 150:
        raise InvalidInput("name must be nonempty text, at most 150 characters.")
    if config.get("domain") != domain.domain:
        raise InvalidInput("Agent configuration must match the selected domain category.")
    try:
        validate_config(
            config, {"model_configs": list_model_configs(), "services": list_services()}
        )
    except ValueError as error:
        raise InvalidInput(str(error)) from error


def validate_template_model(template, config):
    if config["model"] not in {item["id"] for item in template["model_options"]}:
        raise InvalidInput(f"Model {config['model']!r} is not offered by this template.")


def create_agent(domain_name, template_id, name, config):
    from agent_factory.factory import AgentFactory

    return agent_data(AgentFactory().create(domain_name, template_id, name, config))


@transaction.atomic
def update_agent(agent_id, domain_name, name, config):
    domain = get_domain(domain_name)
    try:
        parsed_id = UUID(str(agent_id))
    except ValueError as error:
        raise InvalidInput("id must be a valid agent UUID.") from error
    try:
        agent = Agent.objects.select_for_update().get(pk=parsed_id, domain=domain)
    except Agent.DoesNotExist as error:
        raise NotFound(
            f"Agent {agent_id!r} not found in domain {domain_name!r}."
        ) from error
    merged = merge_config(agent.config, config)
    validate_agent(name, merged, domain)
    try:
        validate_template_model(get_template(agent.template_id), merged)
    except TemplateNotFound:
        pass  # The source template was removed; its saved configuration stays editable.
    if merged["model"] != agent.config["model"] or merged.get("model_parameters", {}) != agent.config.get("model_parameters", {}) or not agent.model_config:
        from agent_factory.factory import model_snapshot

        agent.model_config = model_snapshot(merged)
    agent.name, agent.config = name.strip(), merged
    agent.save(update_fields=["name", "config", "model_config", "updated_at"])
    return agent_data(agent)


@transaction.atomic
def delete_agent(agent_id, domain_name):
    domain = get_domain(domain_name)
    try:
        parsed_id = UUID(str(agent_id))
    except ValueError as error:
        raise InvalidInput("id must be a valid agent UUID.") from error
    try:
        agent = Agent.objects.select_for_update().get(pk=parsed_id, domain=domain)
    except Agent.DoesNotExist as error:
        raise NotFound(
            f"Agent {agent_id!r} not found in domain {domain_name!r}."
        ) from error
    agent.delete()


def get_domain_agents_templates(domain_name):
    domain = get_domain(domain_name)
    return templates_with_options(template_queryset().filter(config__domain=domain.domain))


def get_service_agent_registry(service_name="", domain_name=""):
    agents = Agent.objects.all()
    if domain_name:
        agents = agents.filter(domain=get_domain(domain_name))
    if service_name:
        if not ServiceDefinition.objects.filter(pk=service_name).exists():
            raise NotFound(f"Service {service_name!r} not found.")
        agents = agents.filter(config__service=service_name)
    return [agent_data(agent) for agent in agents]
