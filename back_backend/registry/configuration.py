from django.core.exceptions import ValidationError
from django.core.validators import URLValidator


def string_list(value, field):
    if not isinstance(value, list) or len(value) > 50 or any(not isinstance(item, str) or not item.strip() or len(item) > 1000 for item in value):
        raise ValueError(f'{field} must be a list of at most 50 nonempty strings.')


def validate_config(config, catalog):
    if not isinstance(config, dict):
        raise ValueError('config must be an object.')
    required = {'description', 'instructions', 'questions', 'domain', 'model', 'service', 'page', 'attached_services', 'created_by', 'roles', 'capabilities'}
    if set(config) != required:
        raise ValueError('config must contain exactly the documented configuration fields.')
    for field in ('description', 'instructions', 'domain', 'model', 'service', 'created_by'):
        if not isinstance(config[field], str) or not config[field].strip() or len(config[field]) > 10000:
            raise ValueError(f'{field} must be nonempty text, at most 10000 characters.')
    if not isinstance(config['page'], str) or len(config['page']) > 255:
        raise ValueError('page must be text, at most 255 characters.')
    for field in ('questions', 'attached_services', 'roles'):
        string_list(config[field], field)
    if len(set(config['attached_services'])) != len(config['attached_services']):
        raise ValueError('attached_services must not contain duplicates.')
    models = {item['id']: item for item in catalog['model_configs'] if item['enabled']}
    services = {item['id']: item for item in catalog['services'] if item['enabled']}
    if config['model'] not in models:
        raise ValueError('model must reference an enabled model configuration.')
    for service_id in [config['service'], *config['attached_services']]:
        if service_id not in services or services[service_id].get('domain') != config['domain']:
            raise ValueError('Service references must be enabled and match the configured domain.')
    capabilities = config['capabilities']
    if not isinstance(capabilities, dict) or set(capabilities) != {'alerts', 'webhooks'}:
        raise ValueError('capabilities must contain alerts and webhooks.')
    alerts, webhooks = capabilities['alerts'], capabilities['webhooks']
    if not isinstance(alerts, dict) or set(alerts) != {'enabled', 'severity'} or type(alerts['enabled']) is not bool or alerts['severity'] not in ('info', 'warning', 'critical'):
        raise ValueError('alerts requires an enabled boolean and severity: info, warning, or critical.')
    if not isinstance(webhooks, dict) or set(webhooks) != {'enabled', 'url'} or type(webhooks['enabled']) is not bool or not isinstance(webhooks['url'], str):
        raise ValueError('webhooks requires an enabled boolean and URL string.')
    if webhooks['enabled'] and not webhooks['url']:
        raise ValueError('Enabled webhooks require an HTTPS URL.')
    if webhooks['url']:
        try:
            URLValidator(schemes=['https'])(webhooks['url'])
        except ValidationError as error:
            raise ValueError('Webhook URL must be a valid HTTPS URL.') from error
