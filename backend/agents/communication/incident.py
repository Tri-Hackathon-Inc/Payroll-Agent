"""Incident Report receiver for the common response envelope."""
from runtime.incidents import create_report
from .artifacts import save_incident


def receive(agent, envelope, context):
    findings = [{**item, 'name': item.get('name') or item.get('employeeName') or 'Whole payrun'}
                for item in context.evidence['detection']['findings']]
    result = create_report(agent, envelope['domainName'], {
        'payrunId': context.entity_id, 'employeeId': context.response.get('scope'),
        'handoff': {'fromAgent': envelope['sender']['name'], 'communication': envelope,
                    'conversation': [{'role': 'agent', 'text': context.response['summary']}]},
    }, context=context.evidence['context'], selected_signals=findings, notify=False, context_source=envelope['sender']['id'])
    from runtime.incident_document import readable_report
    result['incident']['report'] = readable_report(result['incident'],
        currency=context.evidence['context']['current'].get('currency', 'USD'),
        conclusion=context.response.get('summary'))
    result['handoff'] = {key: envelope[key] for key in ('id', 'schemaVersion', 'sender', 'recipient', 'source', 'entity')}
    result['artifacts'] = save_incident(envelope, context, result['incident'])
    result['pipeline'] = {'status': 'completed' if not result['incident']['screenshots'].get('error') else 'completed_with_warnings',
                          'stages': ['context_received', 'snapshot_reconstructed', 'evidence_captured', 'report_created', 'artifacts_stored']}
    return result
