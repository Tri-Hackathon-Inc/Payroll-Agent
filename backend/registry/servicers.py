import logging
from functools import wraps

import grpc
from django.db import close_old_connections
from google.protobuf.json_format import MessageToDict, ParseDict
from google.protobuf.empty_pb2 import Empty

from . import metrics, services
from .agent_chat import AgentChat
from .model_runtime import ModelConfigurationError, ModelExecutionError, ModelTimeout
from .proto import templates_pb2 as pb
from .proto import templates_pb2_grpc as rpc

logger = logging.getLogger(__name__)


def rpc_handler(handler):
    @wraps(handler)
    def wrapped(self, request, context):
        close_old_connections()
        try:
            return handler(self, request, context)
        except services.NotFound as error:
            context.abort(grpc.StatusCode.NOT_FOUND, str(error))
        except services.InvalidInput as error:
            context.abort(grpc.StatusCode.INVALID_ARGUMENT, str(error))
        except ModelConfigurationError as error:
            context.abort(grpc.StatusCode.FAILED_PRECONDITION, str(error))
        except ModelTimeout as error:
            context.abort(grpc.StatusCode.DEADLINE_EXCEEDED, str(error))
        except ModelExecutionError as error:
            context.abort(grpc.StatusCode.UNAVAILABLE, str(error))
        except Exception:
            logger.exception("Template catalog RPC failed")
            context.abort(grpc.StatusCode.INTERNAL, "Template catalog unavailable.")
        finally:
            close_old_connections()

    return wrapped


class AIStudioServicer(rpc.ai_studioServicer):
    @rpc_handler
    def ChatAgent(self, request, context):
        return ParseDict(AgentChat().reply(
            request.agent_id, request.domain_name, request.message,
            [{"role": item.role, "content": item.content} for item in request.history],
        ), pb.ChatAgentResponse())

    @rpc_handler
    def ListTemplates(self, request, context):
        return pb.TemplateList(
            templates=[
                ParseDict(item, pb.Template()) for item in services.list_templates(request.service_name)
            ]
        )

    @rpc_handler
    def GetTemplate(self, request, context):
        return ParseDict(services.get_template(request.id), pb.Template())

    @rpc_handler
    def ListDomains(self, request, context):
        return pb.DomainList(
            domains=[
                ParseDict(item, pb.Domain()) for item in services.list_domains()
            ]
        )

    @rpc_handler
    def GetDomainAgentsTemplates(self, request, context):
        return pb.TemplateList(templates=[
            ParseDict(item, pb.Template())
            for item in services.get_domain_agents_templates(request.domain_name)
        ])

    @rpc_handler
    def GetServiceAgentRegistry(self, request, context):
        return pb.AgentList(agents=[
            ParseDict(item, pb.Agent())
            for item in services.get_service_agent_registry(request.service_name, request.domain_name)
        ])

    @rpc_handler
    def CreateAgent(self, request, context):
        return ParseDict(
            services.create_agent(
                request.domain_name,
                request.template_id,
                request.name,
                MessageToDict(request.config),
            ),
            pb.Agent(),
        )

    @rpc_handler
    def UpdateAgent(self, request, context):
        return ParseDict(
            services.update_agent(
                request.id,
                request.domain_name,
                request.name,
                MessageToDict(request.config),
            ),
            pb.Agent(),
        )

    @rpc_handler
    def DeleteAgent(self, request, context):
        services.delete_agent(request.id, request.domain_name)
        return Empty()

    @rpc_handler
    def RecordInteraction(self, request, context):
        return pb.InteractionRef(id=metrics.record_interaction(
            request.domain_name, request.agent_id, MessageToDict(request.data)))

    @rpc_handler
    def RateInteraction(self, request, context):
        return pb.InteractionRef(id=metrics.rate_interaction(
            request.domain_name, request.interaction_id, request.rating))

    @rpc_handler
    def GetAgentMetrics(self, request, context):
        result = pb.AgentMetrics()
        result.metrics.update(metrics.agent_metrics(request.domain_name, request.agent_id, request.since_hours))
        return result
