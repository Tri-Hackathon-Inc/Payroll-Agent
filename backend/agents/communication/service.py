"""One discovery, authorization, provenance and delivery boundary for agents.

Publishers resolve trusted saved responses; receivers consume context as data.
Neither the browser nor a model can supply executable instructions or credentials.
"""
from runtime import agent_access
import re
from uuid import UUID
from django.db import transaction
from storage.models import Agent, AgentMessage, ServiceDefinition
from template.services import agent_data
from runtime import access
from runtime.common import RuntimeFailure, digest

PUBLISHERS = {}
RECEIVERS = {}


def register_publisher(kind, resolver):
    PUBLISHERS[kind] = resolver


def register_receiver(capability, receiver):
    RECEIVERS[capability] = receiver


def defaults():
    from .interface import Receiver
    from agents.anomaly_detection.handoff import resolve_response
    from .incident import receive
    PUBLISHERS.setdefault('anomaly-investigation', resolve_response)
    RECEIVERS.setdefault('incident-report', Receiver('incident-report', ('payrun',), receive, version=3))


def available(agent, viewer):
    config = agent.config
    if viewer['allowedModels'] and config.get('model') not in viewer['allowedModels']:
        return False
    tools = {config.get('service'), *config.get('attached_services', [])} - {None, ''}
    if viewer['allowedTools'] and not tools <= set(viewer['allowedTools']):
        return False
    return True


def attached(agent, service):
    return service in [agent.config.get('service'), *agent.config.get('attached_services', [])]


def communicate(body, headers):
    defaults()
    viewer = access.require(headers, 'testAgents')
    owner = headers.get('x-session-owner', '')
    if not isinstance(owner, str) or not re.fullmatch(r'[a-f0-9]{64}', owner):
        raise RuntimeFailure('A browser session is required for handoffs.', 400)
    if body.get('action') not in ('DISCOVER', 'SEND'):
        raise RuntimeFailure('Choose DISCOVER or SEND.', 400)
    try:
        sender_id = UUID(str(body.get('agentId')))
    except ValueError as error:
        raise RuntimeFailure('A valid sender agent is required.', 400) from error
    sender = Agent.objects.filter(pk=sender_id, domain_id=body.get('domainName')).first()
    if sender is None or not available(sender, viewer):
        raise RuntimeFailure('Sender agent is unavailable.', 404)
    service = body.get('service') or sender.config.get('service')
    if not attached(sender, service) or not ServiceDefinition.objects.filter(pk=service, enabled=True, domain=sender.config.get('domain')).exists():
        raise RuntimeFailure('The sender is not attached to an enabled service.', 400)
    agent_access.require_read(agent_data(sender))
    receiver = RECEIVERS.get(body.get('capability'))
    publisher = PUBLISHERS.get(body.get('responseType'))
    if receiver is None or publisher is None:
        raise RuntimeFailure('This communication capability is not registered.', 400)
    # Every delivery rechecks the saved source, scope and current source version.
    context = publisher(agent_data(sender), body, body['action'] == 'SEND')
    candidates = [agent for agent in Agent.objects.filter(domain_id=sender.domain_id, template_id=receiver.template_id)
                  if agent.pk != sender.pk and attached(agent, service) and available(agent, viewer)
                  and agent_access.can_read_context(agent.pk, sender.pk, sender.domain_id)
                  and context.entity_type in receiver.entity_types]
    if body['action'] == 'DISCOVER':
        return {'agents': [{'id': str(agent.pk), 'name': agent.name} for agent in candidates]}
    target = next((agent for agent in candidates if str(agent.pk) == body.get('targetAgentId')), None)
    if target is None:
        raise RuntimeFailure('The receiving agent is no longer available on this service.', 409)
    identity = digest([sender.domain_id, str(sender.pk), str(target.pk), service,
                       body['capability'], receiver.version, body['responseType'], context.reference, context.version])
    # Claim before calling a receiver. A crash leaves processing visible instead
    # of replaying a possibly completed operation automatically.
    with transaction.atomic():
        message, created = AgentMessage.objects.get_or_create(id=identity, defaults={
            'domain_id': sender.domain_id, 'sender_id': sender.pk, 'recipient_id': target.pk,
            'service': service, 'capability': body['capability'], 'source_reference': context.reference,
            'source_version': context.version, 'requested_by': digest(owner), 'status': 'processing'})
        if not created:
            return {'id': identity, 'status': message.status, 'result': message.result}
    envelope = {'id': identity, 'schemaVersion': 1, 'domainName': sender.domain_id,
                'service': service, 'capability': body['capability'],
                'sender': {'id': str(sender.pk), 'name': sender.name},
                'recipient': {'id': str(target.pk), 'name': target.name},
                'source': {'type': body['responseType'], 'id': context.reference, 'version': context.version},
                'entity': {'type': context.entity_type, 'id': context.entity_id},
                'response': context.response}
    try:
        result = receiver.receive(agent_data(target), envelope, context)
    except Exception:
        AgentMessage.objects.filter(pk=identity).update(status='failed', result={'message': 'Report creation failed. Contact an administrator before attempting another handoff.'})
        raise RuntimeFailure('Report creation failed; the handoff was recorded.', 503)
    AgentMessage.objects.filter(pk=identity).update(status='completed', result=result)
    return {'id': identity, 'status': 'completed', 'result': result}
