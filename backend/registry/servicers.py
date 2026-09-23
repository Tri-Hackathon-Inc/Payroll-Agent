import logging
from functools import wraps
import grpc
from django.db import close_old_connections
from google.protobuf.json_format import ParseDict
from google.protobuf.struct_pb2 import Struct
from . import services
from .proto import templates_pb2 as pb, templates_pb2_grpc as rpc

logger = logging.getLogger(__name__)


def rpc_handler(handler):
    @wraps(handler)
    def wrapped(self, request, context):
        close_old_connections()
        try:
            return handler(self, request, context)
        except services.TemplateNotFound as error:
            context.abort(grpc.StatusCode.NOT_FOUND, str(error))
        except Exception:
            logger.exception('Template catalog RPC failed')
            context.abort(grpc.StatusCode.INTERNAL, 'Template catalog unavailable.')
        finally:
            close_old_connections()
    return wrapped


class TemplateCatalogServicer(rpc.TemplateCatalogServicer):
    @rpc_handler
    def ListTemplates(self, request, context):
        return pb.TemplateList(templates=[ParseDict(item, pb.Template()) for item in services.list_templates()])

    @rpc_handler
    def GetTemplate(self, request, context):
        return ParseDict(services.get_template(request.id), pb.Template())

    @rpc_handler
    def ListModelConfigs(self, request, context):
        return pb.ConfigurationList(items=[ParseDict(item, Struct()) for item in services.list_model_configs()])

    @rpc_handler
    def ListServices(self, request, context):
        return pb.ConfigurationList(items=[ParseDict(item, Struct()) for item in services.list_services()])
