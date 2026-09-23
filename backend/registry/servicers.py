import logging
from functools import wraps

import grpc
from django.db import close_old_connections
from google.protobuf.json_format import MessageToDict, ParseDict

from . import services
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
        except Exception:
            logger.exception("Template catalog RPC failed")
            context.abort(grpc.StatusCode.INTERNAL, "Template catalog unavailable.")
        finally:
            close_old_connections()

    return wrapped


class TemplateCatalogServicer(rpc.TemplateCatalogServicer):
    @rpc_handler
    def ListTemplates(self, request, context):
        return pb.TemplateList(
            templates=[
                ParseDict(item, pb.Template()) for item in services.list_templates()
            ]
        )

    @rpc_handler
    def GetTemplate(self, request, context):
        return ParseDict(services.get_template(request.id), pb.Template())

    @rpc_handler
    def ListBusinesses(self, request, context):
        return pb.BusinessList(
            businesses=[
                ParseDict(item, pb.Business()) for item in services.list_businesses()
            ]
        )

    @rpc_handler
    def GetBusinessAgents(self, request, context):
        return pb.AgentList(
            agents=[
                ParseDict(item, pb.Agent())
                for item in services.get_business_agents(request.business_name)
            ]
        )

    @rpc_handler
    def CreateAgent(self, request, context):
        return ParseDict(
            services.create_agent(
                request.business_name,
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
                request.business_name,
                request.name,
                MessageToDict(request.config),
            ),
            pb.Agent(),
        )
