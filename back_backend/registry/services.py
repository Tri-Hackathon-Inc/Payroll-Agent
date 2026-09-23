"""Template catalog operations shared by GraphQL and gRPC."""
from django.db import transaction
from .catalog import load_catalog
from .models import ModelConfiguration, ServiceDefinition, Template


class TemplateNotFound(Exception):
    pass


@transaction.atomic
def sync_templates():
    # Validate all source files before making any database changes.
    catalog = load_catalog()
    for entry in catalog['model_configs']:
        values = {key: entry[key] for key in ('name', 'provider', 'model_id', 'enabled', 'parameters')}
        values.update(endpoint_env=entry.get('endpoint_env', ''), credential_env=entry.get('credential_env', ''))
        ModelConfiguration.objects.update_or_create(id=entry['id'], defaults=values)
    for entry in catalog['services']:
        values = {key: entry[key] for key in ('name', 'domain', 'enabled', 'base_url_env', 'method', 'path')}
        ServiceDefinition.objects.update_or_create(id=entry['id'], defaults=values)
    for entry in catalog['templates']:
        config = entry['config']
        template, _ = Template.objects.update_or_create(id=entry['id'], defaults={
            'name': entry['name'], 'description': entry['description'], 'version': entry['version'],
            'config': config, 'default_model_id': config['model'], 'service_id': config['service'],
        })
        template.attached_services.set(config['attached_services'])
    # The database is a projection of the source files, including removals.
    Template.objects.exclude(id__in=[item['id'] for item in catalog['templates']]).delete()
    ModelConfiguration.objects.exclude(id__in=[item['id'] for item in catalog['model_configs']]).delete()
    ServiceDefinition.objects.exclude(id__in=[item['id'] for item in catalog['services']]).delete()
    return {key: len(items) for key, items in catalog.items()}


def model_data(model):
    return {key: getattr(model, key) for key in ('id', 'name', 'provider', 'model_id', 'enabled', 'endpoint_env', 'credential_env', 'parameters')}


def service_data(service):
    return {key: getattr(service, key) for key in ('id', 'name', 'domain', 'enabled', 'base_url_env', 'method', 'path')}


def template_data(template):
    attached = {item.id: item for item in template.attached_services.all()}
    return {
        'id': template.id, 'name': template.name, 'description': template.description,
        'version': template.version, 'config': template.config,
        'model_config': model_data(template.default_model),
        'service': service_data(template.service),
        'attached_services': [service_data(attached[key]) for key in template.config['attached_services']],
    }


def template_queryset():
    return Template.objects.select_related('default_model', 'service').prefetch_related('attached_services')


def list_templates():
    return [template_data(template) for template in template_queryset()]


def get_template(template_id):
    try:
        return template_data(template_queryset().get(pk=template_id))
    except Template.DoesNotExist as error:
        raise TemplateNotFound(f'Template {template_id!r} not found.') from error


def list_model_configs():
    return [model_data(model) for model in ModelConfiguration.objects.order_by('id')]


def list_services():
    return [service_data(service) for service in ServiceDefinition.objects.order_by('id')]
