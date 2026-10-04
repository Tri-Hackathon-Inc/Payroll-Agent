from tests.access_fixtures import grant_read
import os
import json
import tempfile
from pathlib import Path
from unittest.mock import patch
from django.test import TestCase
from agent_factory.factory import AgentFactory
from agents.communication.service import communicate
from agents.communication.incident import receive
from runtime.common import RuntimeFailure
from storage.models import AgentMessage, Domain, ServiceDefinition
from template import services
from tests.test_runtime import fixture


@patch.dict(os.environ, STUDIO_ADMIN_KEY='')
class AgentCommunicationTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name='payroll-services', defaults={'label': 'Payroll', 'domain': 'Payroll'})
        Domain.objects.get_or_create(name='other', defaults={'label': 'Other', 'domain': 'Payroll'})

    def setUp(self):
        artifacts = tempfile.TemporaryDirectory()
        self.addCleanup(artifacts.cleanup)
        environment = patch.dict(os.environ, INCIDENT_ARTIFACT_ROOT=artifacts.name)
        environment.start()
        self.addCleanup(environment.stop)
        self.artifact_root = Path(artifacts.name)
        self.sender = AgentFactory().create('payroll-services', 'anomaly-detection', 'AD', {'model': 'poc-demo'})
        self.target = AgentFactory().create('payroll-services', 'incident-report', 'Reports',
            {'model': 'poc-demo', 'service': self.sender.config['service']})
        grant_read(self.sender)
        grant_read(self.target)
        from storage.models import AgentContextPermission
        AgentContextPermission.objects.create(reader=self.target, source=self.sender)
        self.agent = AgentFactory().load('payroll-services', str(self.sender.pk))
        self.context = fixture()
        _, self.case = self.agent.check(self.context)
        self.case.review_status = 'completed'
        self.case.investigation = {'modelStatus': 'completed', 'summary': 'Verify recorded overtime.', 'findings': [], 'evidence': []}
        self.case.save()
        self.headers = {'x-session-owner': 'a' * 64}
        self.body = {'action': 'DISCOVER', 'domainName': 'payroll-services', 'agentId': str(self.sender.pk),
                     'capability': 'incident-report', 'responseType': 'anomaly-investigation',
                     'responseId': self.case.pk, 'expectedVersion': self.case.payrun_version,
                     'targetAgentId': str(self.target.pk)}

    def test_discovery_does_not_invoke_agents_and_is_domain_scoped(self):
        AgentFactory().create('other', 'incident-report', 'Other reports', {'model': 'poc-demo'})
        with patch('agents.communication.incident.create_report') as report:
            result = communicate(self.body, self.headers)
        self.assertEqual(result['agents'], [{'id': str(self.target.pk), 'name': 'Reports'}])
        report.assert_not_called()
        self.assertEqual(AgentMessage.objects.count(), 0)

    def test_send_transfers_saved_response_and_duplicate_returns_same_report(self):
        with patch('runtime.payroll.load_context', return_value=self.context), patch(
                'agents.communication.incident.create_report', return_value={'incident': {'id': 'INC-test', 'report': 'Evidence', 'evidence': [], 'screenshots': {},
                    'title': 'Payroll review', 'impactedService': 'payrun', 'payrunId': self.case.payrun_id, 'expectedBehavior': 'Verify approved pay.'}}) as report:
            first = communicate({**self.body, 'action': 'SEND', 'response': {'summary': 'forged'}}, self.headers)
            second = communicate({**self.body, 'action': 'SEND'}, self.headers)
        self.assertEqual(first, second)
        report.assert_called_once()
        self.assertFalse(report.call_args.kwargs['notify'])
        self.assertEqual(report.call_args.args[2]['handoff']['communication']['response']['summary'], 'Verify recorded overtime.')
        self.assertEqual(AgentMessage.objects.get().status, 'completed')
        self.assertTrue((self.artifact_root / first['id'] / 'report.md').is_file())
        manifest = json.loads((self.artifact_root / first['id'] / 'manifest.json').read_text())
        self.assertEqual(manifest['source']['id'], self.case.pk)

    def test_recipient_must_still_be_attached(self):
        self.target.config['service'] = 'unrelated'
        self.target.config['attached_services'] = []
        self.target.save()
        self.assertEqual(communicate(self.body, self.headers)['agents'], [])
        with patch('runtime.payroll.load_context', return_value=self.context), self.assertRaises(RuntimeFailure):
            communicate({**self.body, 'action': 'SEND'}, self.headers)
        self.assertFalse(AgentMessage.objects.exists())

    def test_incomplete_or_foreign_response_cannot_be_sent(self):
        for changes in ({'responseId': 'missing'}, {'expectedVersion': 999}):
            with self.assertRaises(RuntimeFailure):
                communicate({**self.body, **changes}, self.headers)
        self.case.review_status = 'failed'
        self.case.save()
        with self.assertRaises(RuntimeFailure):
            communicate(self.body, self.headers)

    def test_stale_source_blocks_send(self):
        changed = fixture()
        changed['current']['version'] += 1
        with patch('runtime.payroll.load_context', return_value=changed), self.assertRaises(RuntimeFailure):
            communicate({**self.body, 'action': 'SEND'}, self.headers)
        self.assertFalse(AgentMessage.objects.exists())

    def test_disabled_service_and_missing_session_block_discovery(self):
        with self.assertRaises(RuntimeFailure):
            communicate(self.body, {})
        ServiceDefinition.objects.filter(pk=self.sender.config['service']).update(enabled=False)
        with self.assertRaises(RuntimeFailure):
            communicate(self.body, self.headers)

    def test_receiver_failure_is_durable_and_never_replayed(self):
        with patch('runtime.payroll.load_context', return_value=self.context), patch(
                'agents.communication.incident.create_report', side_effect=ValueError('private')) as report:
            with self.assertRaises(RuntimeFailure):
                communicate({**self.body, 'action': 'SEND'}, self.headers)
            result = communicate({**self.body, 'action': 'SEND'}, self.headers)
        report.assert_called_once()
        self.assertEqual(result['status'], 'failed')
        self.assertNotIn('private', str(result))

    def test_report_preserves_payrun_findings_and_never_delivers_notifications(self):
        from agents.communication.interface import ResponseContext
        context = ResponseContext(self.case.pk, self.case.payrun_version, 'payrun', self.case.payrun_id,
            self.case.investigation, self.case.snapshot)
        context.evidence['detection']['findings'].append({'employeeId': None, 'employeeName': 'Decision model',
            'kind': 'decision_model', 'detail': 'Review requested', 'severity': 'warning', 'amountAtRisk': None, 'evidence': {}})
        with patch.dict(os.environ, EVIDENCE_CAPTURE_URL='', EMAIL_API_BASE_URL='https://example.invalid', SLACK_WEBHOOK_URL='https://example.invalid'), patch('runtime.incidents.deliver') as delivery:
            report = receive(services.agent_data(self.target), {'domainName': 'payroll-services', 'sender': {'id': str(self.sender.pk), 'name': 'AD'},
                'id': 'a' * 64, 'schemaVersion': 1, 'recipient': {}, 'source': {}, 'entity': {}}, context)
        delivery.assert_not_called()
        self.assertIn('Verify recorded overtime.', report['incident']['report'])
        self.assertLessEqual(len(report['incident']['title'].split()), 6)
        for heading in ('## Expected system behavior', '## Impacted service', '## Evidence snapshots'):
            self.assertIn(heading, report['incident']['report'])
        self.assertIn('approval records and company policy were not supplied', report['incident']['report'])
        self.assertIn('No evidence snapshots were captured', report['incident']['report'])
        self.assertEqual(report['incident']['impactedService'], self.target.config['service'])
        self.assertEqual(report['incident']['evidence'][-1]['name'], 'Decision model')

    def test_snapshot_bytes_are_saved_once_with_relative_report_links(self):
        from agents.communication.artifacts import save_incident
        from agents.communication.interface import ResponseContext
        image = 'data:image/png;base64,aW1hZ2U='
        incident = {'id': 'INC-test', 'report': f'![evidence]({image})', 'screenshots': {},
            'evidence': [{'screenshots': [{'label': 'Row', 'dataUrl': image}, {'label': 'Row again', 'dataUrl': image}]}]}
        context = ResponseContext(self.case.pk, 1, 'payrun', 'p', {}, self.case.snapshot)
        result = save_incident({'id': 'b' * 64}, context, incident)
        self.assertEqual(result['snapshotCount'], 1)
        folder = self.artifact_root / ('b' * 64)
        self.assertEqual((folder / 'snapshots/001.png').read_bytes(), b'image')
        self.assertIn('snapshots/001.png', (folder / 'report.md').read_text())
        self.assertNotIn('base64', json.dumps(incident))
        with self.assertRaises(ValueError):
            save_incident({'id': '../outside'}, context, incident)

    def test_recipient_revocation_prevents_context_transfer(self):
        from storage.models import AgentContextPermission
        AgentContextPermission.objects.filter(reader=self.target).delete()
        with patch('agents.communication.incident.create_report') as report:
            self.assertEqual(communicate(self.body, self.headers)['agents'], [])
            with patch('runtime.payroll.load_context', return_value=self.context), self.assertRaises(RuntimeFailure):
                communicate({**self.body, 'action':'SEND'}, self.headers)
        report.assert_not_called()

    def test_sender_revocation_prevents_loading_saved_context(self):
        from storage.models import AgentGroupMembership
        from agents.communication import service
        AgentGroupMembership.objects.filter(agent=self.sender).delete()
        with patch.dict(service.PUBLISHERS, {'anomaly-investigation': lambda *args: self.fail('Context must not be read')}):
            with self.assertRaises(RuntimeFailure): communicate(self.body, self.headers)

    def test_report_read_permission_does_not_allow_notification_writes(self):
        from runtime.incidents import create_report
        with patch.dict(os.environ, EVIDENCE_CAPTURE_URL='', EMAIL_API_BASE_URL='https://example.invalid', SLACK_WEBHOOK_URL='https://example.invalid'), patch('runtime.incidents.deliver') as delivery:
            result = create_report(services.agent_data(self.target), 'payroll-services', {'payrunId': self.case.payrun_id}, context=self.context, notify=True)
        delivery.assert_not_called()
        self.assertIn('incident', result)

    def test_context_permission_is_directional_and_required_for_handoff(self):
        from storage.models import AgentContextPermission
        from runtime.agent_access import can_read_context
        self.assertTrue(can_read_context(self.target.pk,self.sender.pk,'payroll-services'))
        self.assertFalse(can_read_context(self.sender.pk,self.target.pk,'payroll-services'))
        AgentContextPermission.objects.all().delete()
        self.assertEqual(communicate(self.body,self.headers)['agents'],[])

    def test_handoff_context_does_not_require_recipient_source_api_access(self):
        from storage.models import AgentGroupMembership
        AgentGroupMembership.objects.filter(agent=self.target).delete()
        with patch('runtime.payroll.load_context',return_value=self.context), patch.dict(os.environ,EVIDENCE_CAPTURE_URL=''), patch('runtime.incidents.deliver') as delivery:
            result = communicate({**self.body,'action':'SEND'},self.headers)
        self.assertEqual(result['status'],'completed')
        delivery.assert_not_called()
