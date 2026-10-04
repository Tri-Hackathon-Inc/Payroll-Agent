"""Publish only completed, persisted anomaly investigations."""
from copy import deepcopy
from agents.communication.interface import ResponseContext
from runtime.common import RuntimeFailure
from .models import AnomalyCase


def resolve_response(sender, body, refresh):
    case = AnomalyCase.objects.filter(pk=body.get('responseId'), domain_id=sender['domain_name'], agent_id=sender['id']).first()
    if case is None:
        raise RuntimeFailure('Investigation not found for this sender.', 404)
    if (case.review_status != 'completed' or not case.investigation
            or case.investigation.get('modelStatus') != 'completed'):
        raise RuntimeFailure('Complete the investigation before creating a report.', 409)
    if isinstance(body.get('expectedVersion'), bool) or body.get('expectedVersion') != case.payrun_version:
        raise RuntimeFailure('The investigation version changed.', 409)
    if case.audit.filter(action='DISMISSED').exists():
        raise RuntimeFailure('Dismissed findings cannot be handed off.', 409)
    if refresh:
        from .components import AnomalyComponents
        components = AnomalyComponents(sender['config'])
        expected = components.domain.reference(case.snapshot['context'])
        current = components.domain.reference(components.domain.load(components.domain.invocation(expected)))
        if current != expected or case.snapshot.get('components') != components.settings:
            raise RuntimeFailure('Source data or agent settings changed. Run a new investigation.', 409)
    response = {key: deepcopy(case.investigation.get(key)) for key in ('summary', 'findings', 'evidence', 'modelStatus')}
    response['scope'] = case.snapshot.get('scope', case.snapshot.get('employeeId'))
    return ResponseContext(case.id, case.payrun_version, case.entity_type, case.payrun_id, response, deepcopy(case.snapshot))
