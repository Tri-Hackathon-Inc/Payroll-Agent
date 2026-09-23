import json
import shutil
from pathlib import Path
from tempfile import TemporaryDirectory
from django.conf import settings
from django.core.management import call_command, CommandError
from io import StringIO
from .catalog import CatalogError, load_catalog
from django.test import SimpleTestCase, override_settings


class TemplateCatalogTests(SimpleTestCase):
    """SimpleTestCase also ensures template loading never accesses a database."""

    def test_catalog_contains_oob_templates_models_and_services(self):
        catalog = load_catalog()
        self.assertEqual({item['id'] for item in catalog['templates']}, {
            'anomaly-detection', 'summarizer', 'general-query', 'failure-investigation',
        })
        for template in catalog['templates']:
            self.assertIn('alerts', template['config']['capabilities'])
            self.assertIn('webhooks', template['config']['capabilities'])
            self.assertTrue(template['config']['instructions'])
        self.assertTrue(any(item['id'] == 'poc-demo' for item in catalog['model_configs']))
        self.assertTrue(any(item['id'] == 'payrun' for item in catalog['services']))

    def test_no_rest_endpoints_are_exposed(self):
        self.assertEqual(self.client.post('/list-template/', {}).status_code, 404)
        self.assertEqual(self.client.put('/template/agent1/', '{}', content_type='application/json').status_code, 404)
        for path in ['/list-template/', '/list-template', '/services/agents-list', '/services/agent1', '/api/agents/']:
            with self.subTest(path=path):
                self.assertEqual(self.client.get(path).status_code, 404)

    def test_template_file_edits_and_new_templates_are_visible(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / 'templates'
            shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
            with override_settings(TEMPLATE_CONFIG_DIR=root):
                path = root / 'summarizer.json'
                template = json.loads(path.read_text())
                template['config']['instructions'] = 'Updated instructions'
                template['version'] = 2
                path.write_text(json.dumps(template))
                template['id'] = 'custom-summary'
                (root / 'custom-summary.json').write_text(json.dumps(template))
                catalog = load_catalog()
                self.assertEqual(len(catalog['templates']), 5)
                updated = next(item for item in catalog['templates'] if item['id'] == 'summarizer')
                self.assertEqual(updated['version'], 2)
                self.assertEqual(updated['config']['instructions'], 'Updated instructions')

    def test_invalid_defaults_and_duplicate_ids_report_catalog_error(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / 'templates'
            shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
            with override_settings(TEMPLATE_CONFIG_DIR=root):
                path = root / 'summarizer.json'
                original = json.loads(path.read_text())
                for overrides in [{'model': 'missing'}, {'service': 'missing'}, {'questions': 'text'},
                                  {'capabilities': {'alerts': {'enabled': 'yes'}}}]:
                    with self.subTest(overrides=overrides):
                        template = json.loads(json.dumps(original))
                        template['config'].update(overrides)
                        path.write_text(json.dumps(template))
                        with self.assertRaises(CatalogError):
                            load_catalog()
                path.write_text(json.dumps(original))
                (root / 'duplicate.json').write_text(json.dumps(original))
                with self.assertRaises(CatalogError):
                    load_catalog()

    def test_invalid_json_reports_catalog_error(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / 'templates'
            shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
            (root / 'services.json').write_text('{invalid')
            with override_settings(TEMPLATE_CONFIG_DIR=root):
                with self.assertRaises(CatalogError):
                    load_catalog()
                with self.assertRaises(CommandError):
                    call_command('validate_templates', stdout=StringIO())

    def test_validation_command_can_export_catalog(self):
        output = StringIO()
        call_command('validate_templates', dump=True, stdout=output)
        self.assertEqual(json.loads(output.getvalue()), load_catalog())


from django.test import TestCase, TransactionTestCase
from . import services
from .models import Template, ModelConfiguration, ServiceDefinition


class BackendCatalogTests(TestCase):
    def setUp(self):
        services.sync_templates()

    def test_sync_is_idempotent_and_links_model_and_services(self):
        services.sync_templates()
        self.assertEqual(Template.objects.count(), 4)
        self.assertEqual(ModelConfiguration.objects.count(), 2)
        self.assertEqual(ServiceDefinition.objects.count(), 4)
        template = services.get_template('anomaly-detection')
        self.assertEqual(template['model_config']['id'], 'poc-demo')
        self.assertEqual(template['service']['id'], 'payrun')
        self.assertEqual(template['attached_services'][0]['id'], 'payrun-history')
        self.assertTrue(template['config']['capabilities']['alerts']['enabled'])

    def test_missing_template(self):
        with self.assertRaises(services.TemplateNotFound):
            services.get_template('missing')

    def test_sync_applies_file_changes_and_removals(self):
        with TemporaryDirectory() as directory:
            root = Path(directory) / 'templates'
            shutil.copytree(settings.TEMPLATE_CONFIG_DIR, root)
            with override_settings(TEMPLATE_CONFIG_DIR=root):
                path = root / 'summarizer.json'
                definition = json.loads(path.read_text())
                definition['version'] = 2
                definition['config']['instructions'] = 'Updated prompt'
                path.write_text(json.dumps(definition))
                (root / 'general-query.json').unlink()
                self.assertEqual(services.get_template('summarizer')['version'], 1)
                services.sync_templates()
                self.assertEqual(services.get_template('summarizer')['version'], 2)
                self.assertEqual(Template.objects.count(), 3)
                before = services.list_templates()
                path.write_text('{invalid')
                with self.assertRaises(CatalogError):
                    services.sync_templates()
                self.assertEqual(services.list_templates(), before)


class GrpcCatalogTests(TransactionTestCase):
    def setUp(self):
        import grpc
        from concurrent.futures import ThreadPoolExecutor
        from .servicers import TemplateCatalogServicer
        from .proto import templates_pb2_grpc as rpc
        services.sync_templates()
        self.server = grpc.server(ThreadPoolExecutor(max_workers=2))
        rpc.add_TemplateCatalogServicer_to_server(TemplateCatalogServicer(), self.server)
        port = self.server.add_insecure_port('127.0.0.1:0')
        self.server.start()
        self.channel = grpc.insecure_channel(f'127.0.0.1:{port}')
        self.stub = rpc.TemplateCatalogStub(self.channel)

    def tearDown(self):
        self.channel.close()
        self.server.stop(0).wait()

    def test_live_servicer_matches_shared_catalog(self):
        import grpc
        from google.protobuf.empty_pb2 import Empty
        from google.protobuf.json_format import MessageToDict
        from .proto.templates_pb2 import TemplateId
        self.assertEqual(len(self.stub.ListTemplates(Empty(), timeout=5).templates), 4)
        template = self.stub.GetTemplate(TemplateId(id='summarizer'), timeout=5)
        self.assertEqual(template.id, 'summarizer')
        self.assertEqual(MessageToDict(template.model_config)['id'], 'poc-demo')
        self.assertEqual(len(self.stub.ListModelConfigs(Empty(), timeout=5).items), 2)
        self.assertEqual(len(self.stub.ListServices(Empty(), timeout=5).items), 4)
        with self.assertRaises(grpc.RpcError) as caught:
            self.stub.GetTemplate(TemplateId(id='missing'), timeout=5)
        self.assertEqual(caught.exception.code(), grpc.StatusCode.NOT_FOUND)
