from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import grpc
from django.test import TestCase, TransactionTestCase
from django.utils import timezone
from google.protobuf.json_format import MessageToDict, ParseDict
from google.protobuf.struct_pb2 import Struct

from . import metrics, services
from .models import AgentInteraction, Domain
from .proto import templates_pb2 as pb
from .proto import templates_pb2_grpc as rpc
from .servicers import AIStudioServicer

DOMAIN = "payroll-services"


def domain():
    return Domain.objects.get_or_create(name=DOMAIN, defaults={"label": "Payroll", "domain": "Payroll"})[0]


class MetricsTests(TestCase):
    def setUp(self):
        services.sync_templates()
        domain()
        Domain.objects.get_or_create(name="hr", defaults={"label": "HR", "domain": "HR"})
        self.agent = services.create_agent(DOMAIN, "anomaly-detection", "Anomaly bot", {"model": "poc-demo"})
        self.other = services.create_agent(DOMAIN, "general-query", "Query bot", {"model": "poc-demo"})

    def record(self, agent=None, **data):
        payload = {"question": "What is the total net pay?", "answeredBy": "payroll-data", "latencyMs": 20,
                   "payrunId": "PR-B", "sessionId": "s1", **data}
        return metrics.record_interaction(DOMAIN, (agent or self.agent)["id"], payload)

    def test_business_and_agent_metrics_are_measured_from_recorded_answers(self):
        self.record(findings={"critical": 4, "warning": 3, "info": 1}, amountAtRisk=32662, incidentId="INC-1", suggestedCount=3)
        # The same payrun asked again counts its findings once (latest answer).
        self.record(question="Which payments need review?", findings={"critical": 4, "warning": 3, "info": 1},
                    amountAtRisk=32662, incidentId="INC-1", suggestedCount=3, latencyMs=40)
        model_answer = self.record(self.other, question="Why are Brooks's taxes so high?", answeredBy="model",
                                   modelId="groq-gpt-oss-120b", latencyMs=1200, modelLatencyMs=1000,
                                   promptTokens=1600, completionTokens=300, checkStatus="flagged", unverifiedCount=1,
                                   sessionId="s2")
        self.record(self.other, question="Why are Brooks's taxes so high?", answeredBy="model", modelId="groq-gpt-oss-120b",
                    latencyMs=15, modelLatencyMs=1000, cached=True, checkStatus="flagged", sessionId="s2")
        self.record(self.other, question="What is FICA?", answeredBy="error", modelId="groq-gpt-oss-120b",
                    latencyMs=900, error="Model call failed: the provider rate limit was reached.")
        self.record(question="benchmark", source="benchmark")
        self.record(question="Automatic check: E1006 pay line changed", source="realtime-monitor", answeredBy="incident-report",
                    incidentId="INC-RT", findings={"critical": 4, "warning": 3, "info": 1}, amountAtRisk=32662, suggestedCount=3)
        metrics.rate_interaction(DOMAIN, model_answer, "down")

        result = metrics.agent_metrics(DOMAIN)
        summary = result["summary"]
        self.assertEqual(summary["questions"], 5, "benchmark runs are excluded")
        self.assertEqual(summary["conversations"], 2)
        self.assertEqual(summary["payrunsReviewed"], 1)
        self.assertEqual(summary["answeredFromData"], 2)
        self.assertEqual(summary["dataShare"], 0.5)
        self.assertEqual(summary["errors"], 1)
        self.assertEqual((summary["up"], summary["down"], summary["helpfulRate"]), (0, 1, 0.0))
        self.assertEqual(summary["p95LatencyMs"], 1200)

        business = result["business"]
        self.assertEqual(business["findings"], {"critical": 4, "warning": 3, "info": 1})
        self.assertEqual(business["amountAtRisk"], 32662.0)
        self.assertEqual(business["incidentsRaised"], 2, "chat and real-time incidents")
        self.assertEqual((business["realtimeChecks"], business["realtimeIncidents"], business["manualIncidents"]), (1, 1, 0))
        self.assertEqual(business["warningsSuggested"], 3)
        self.assertEqual(business["topQuestions"][0], {"question": "why are brooks's taxes so high?", "count": 2})

        quality = result["quality"]
        self.assertEqual((quality["modelAnswers"], quality["cached"], quality["cacheHitRate"]), (2, 1, 0.5))
        self.assertEqual((quality["checked"], quality["flagged"], quality["checkPassRate"]), (2, 2, 0.0))
        self.assertEqual(quality["errorReasons"][0]["count"], 1)

        [model] = result["models"]
        self.assertEqual((model["modelId"], model["calls"], model["errors"], model["promptTokens"]), ("groq-gpt-oss-120b", 3, 1, 1600))
        agents = {item["name"]: item for item in result["agents"]}
        self.assertEqual(agents["Anomaly bot"]["incidents"], 1)
        self.assertEqual(agents["Query bot"]["flagged"], 2)
        self.assertEqual(len(result["recent"]), 5)

        only = metrics.agent_metrics(DOMAIN, agent_id=self.agent["id"])
        self.assertEqual(only["summary"]["questions"], 2)

    def test_consistency_counts_repeated_questions_that_got_different_answers(self):
        ask = lambda question, answer, **extra: self.record(question=question, answerHash=answer, **extra)
        ask("What is the total net pay?", "aa")
        ask("what is the  TOTAL net pay?", "aa")  # same question, same answer
        ask("Why are taxes high?", "b1", answeredBy="model")
        ask("Why are taxes high?", "b2", answeredBy="model")
        ask("Why are taxes high?", "b1", answeredBy="model")
        ask("Why are taxes high?", "c1", answeredBy="model", payrunId="PR-OTHER")  # another payrun
        ask("Only once", "dd")
        quality = metrics.agent_metrics(DOMAIN)["quality"]
        self.assertEqual((quality["repeatedQuestions"], quality["consistent"], quality["consistencyRate"]), (2, 1, 0.5))
        self.assertEqual(quality["variedAnswers"][0], {"question": "why are taxes high?", "agentName": "Anomaly bot",
                                                       "payrunId": "PR-B", "times": 3, "distinctAnswers": 2, "answeredBy": ["model"]})
        with self.assertRaises(services.InvalidInput):
            ask("x", "not-hex!")

    def test_time_window_filters_old_answers(self):
        old = self.record()
        AgentInteraction.objects.filter(pk=old).update(created_at=timezone.now() - timedelta(days=3))
        self.record()
        recent = metrics.agent_metrics(DOMAIN, since_hours=24)
        self.assertEqual(recent["summary"]["questions"], 1)
        self.assertGreaterEqual(len(recent["timeline"]), 24, "quiet hours are shown too")
        self.assertEqual(sum(point["questions"] for point in recent["timeline"]), 1)
        self.assertEqual([item["type"] for item in recent["answerTypes"]], ["payroll-data"], "no empty answer types")
        self.assertEqual(metrics.agent_metrics(DOMAIN)["summary"]["questions"], 2)

    def test_invalid_records_and_feedback_are_rejected(self):
        for bad in [{"answeredBy": "guess"}, {"question": " "}, {"latencyMs": -1}, {"checkStatus": "maybe"},
                    {"findings": [1]}, {"amountAtRisk": "lots"}]:
            with self.assertRaises(services.InvalidInput):
                self.record(**bad)
        with self.assertRaises(services.NotFound):
            metrics.record_interaction("missing", self.agent["id"], {"question": "x", "answeredBy": "model"})
        answer = self.record()
        with self.assertRaises(services.InvalidInput):
            metrics.rate_interaction(DOMAIN, answer, "meh")
        with self.assertRaises(services.NotFound):
            metrics.rate_interaction("hr", answer, "up")
        metrics.rate_interaction(DOMAIN, answer, "up")
        metrics.rate_interaction(DOMAIN, answer, "")
        self.assertEqual(AgentInteraction.objects.get(pk=answer).feedback, "")


class MetricsGrpcTests(TransactionTestCase):
    def test_record_rate_and_read_metrics_over_grpc(self):
        services.sync_templates()
        domain()
        agent = services.create_agent(DOMAIN, "anomaly-detection", "RPC bot", {"model": "poc-demo"})
        server = grpc.server(ThreadPoolExecutor(max_workers=2))
        rpc.add_ai_studioServicer_to_server(AIStudioServicer(), server)
        port = server.add_insecure_port("127.0.0.1:0")
        server.start()
        try:
            with grpc.insecure_channel(f"127.0.0.1:{port}") as channel:
                client = rpc.ai_studioStub(channel)
                data = ParseDict({"question": "Which payments need review?", "answeredBy": "payroll-data", "latencyMs": 12,
                                  "findings": {"critical": 4}}, Struct())
                ref = client.RecordInteraction(pb.RecordInteractionRequest(domain_name=DOMAIN, agent_id=agent["id"], data=data), timeout=5)
                client.RateInteraction(pb.RateInteractionRequest(domain_name=DOMAIN, interaction_id=ref.id, rating="up"), timeout=5)
                reply = client.GetAgentMetrics(pb.AgentMetricsRequest(domain_name=DOMAIN, since_hours=24), timeout=5)
                result = MessageToDict(reply.metrics)
                self.assertEqual(result["summary"]["questions"], 1)
                self.assertEqual(result["summary"]["helpfulRate"], 1)
                for request, code in [
                    (pb.RecordInteractionRequest(domain_name=DOMAIN, agent_id="not-a-uuid", data=data), grpc.StatusCode.INVALID_ARGUMENT),
                    (pb.RecordInteractionRequest(domain_name="missing", agent_id=agent["id"], data=data), grpc.StatusCode.NOT_FOUND),
                ]:
                    with self.assertRaises(grpc.RpcError) as error:
                        client.RecordInteraction(request, timeout=5)
                    self.assertEqual(error.exception.code(), code)
        finally:
            server.stop(None)
