from concurrent.futures import ThreadPoolExecutor

import grpc
from django.test import TransactionTestCase
from google.protobuf.empty_pb2 import Empty
from google.protobuf.json_format import ParseDict
from google.protobuf.struct_pb2 import Struct

from . import services
from .models import Domain
from .proto import templates_pb2 as pb
from .proto import templates_pb2_grpc as rpc
from .servicers import AIStudioServicer


class DomainGrpcTests(TransactionTestCase):
    def test_domain_template_create_and_service_registry_workflow(self):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label": "Payroll", "domain": "Payroll"})
        Domain.objects.create(name="hr", label="HR", domain="HR")
        server = grpc.server(ThreadPoolExecutor(max_workers=2))
        rpc.add_ai_studioServicer_to_server(AIStudioServicer(), server)
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        try:
            with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
                client = rpc.ai_studioStub(channel)
                domains = client.ListDomains(Empty(), timeout=5).domains
                self.assertIn("payroll-services", [d.name for d in domains])
                listed = client.ListTemplates(pb.ServiceName(service_name="payrun"), timeout=5).templates
                self.assertTrue(listed)
                self.assertTrue(all(item.service.fields["id"].string_value == "payrun" for item in listed))
                self.assertEqual(len(client.ListTemplates(pb.ServiceName(service_name="payrun-history"), timeout=5).templates), 0)
                for name, code in [("", grpc.StatusCode.INVALID_ARGUMENT), ("missing", grpc.StatusCode.NOT_FOUND)]:
                    with self.assertRaises(grpc.RpcError) as error:
                        client.ListTemplates(pb.ServiceName(service_name=name), timeout=5)
                    self.assertEqual(error.exception.code(), code)
                templates = client.GetDomainAgentsTemplates(pb.DomainName(domain_name="payroll-services"), timeout=5).templates
                self.assertEqual(len(templates), 5)
                self.assertEqual(len(client.GetDomainAgentsTemplates(pb.DomainName(domain_name="hr"), timeout=5).templates), 0)
                # Keep the integration test offline with the explicitly configured demo provider.
                config = ParseDict({"model": "poc-demo", "service": "payrun"}, Struct())
                agent = client.CreateAgent(pb.CreateAgentRequest(domain_name="payroll-services", template_id="anomaly-detection", name="RPC agent", config=config), timeout=5)
                self.assertEqual(agent.domain_name, "payroll-services")
                reply = client.ChatAgent(pb.ChatAgentRequest(agent_id=agent.id, domain_name="payroll-services", message="Hello"), timeout=5)
                self.assertTrue(reply.demo)
                self.assertEqual(reply.output, "Demo response (no model inference): Hello")
                with self.assertRaises(grpc.RpcError) as error:
                    client.ChatAgent(pb.ChatAgentRequest(agent_id=agent.id, domain_name="hr", message="Hello"), timeout=5)
                self.assertEqual(error.exception.code(), grpc.StatusCode.NOT_FOUND)
                registered = client.GetServiceAgentRegistry(pb.ServiceAgentRegistryRequest(service_name="payrun"), timeout=5).agents
                self.assertEqual([a.id for a in registered], [agent.id])
                self.assertEqual(len(client.GetServiceAgentRegistry(pb.ServiceAgentRegistryRequest(service_name="diagnostics"), timeout=5).agents), 0)
                updated = client.UpdateAgent(pb.UpdateAgentRequest(id=agent.id, domain_name="payroll-services", name="Updated RPC agent", config=ParseDict({"service": "diagnostics"}, Struct())), timeout=5)
                self.assertEqual(updated.id, agent.id)
                self.assertEqual(len(client.GetServiceAgentRegistry(pb.ServiceAgentRegistryRequest(service_name="payrun"), timeout=5).agents), 0)
                self.assertEqual(client.GetServiceAgentRegistry(pb.ServiceAgentRegistryRequest(service_name="diagnostics"), timeout=5).agents[0].id, agent.id)
                with self.assertRaises(grpc.RpcError) as error:
                    client.GetServiceAgentRegistry(pb.ServiceAgentRegistryRequest(service_name="missing"), timeout=5)
                self.assertEqual(error.exception.code(), grpc.StatusCode.NOT_FOUND)
        finally:
            server.stop(0).wait()
