import strawberry
from graphql import GraphQLError
from strawberry.scalars import JSON
from strawberry.extensions import QueryDepthLimiter
from . import services


@strawberry.type
class ModelConfig:
    id: strawberry.ID
    name: str
    provider: str
    model_id: str
    enabled: bool
    endpoint_env: str
    credential_env: str
    parameters: JSON


@strawberry.type
class Service:
    id: strawberry.ID
    name: str
    domain: str
    enabled: bool
    base_url_env: str
    method: str
    path: str


@strawberry.type
class Template:
    id: strawberry.ID
    name: str
    description: str
    version: int
    config: JSON
    model_config: ModelConfig
    service: Service
    attached_services: list[Service]

    @classmethod
    def from_data(cls, data):
        return cls(**{**data, 'model_config': ModelConfig(**data['model_config']),
                      'service': Service(**data['service']),
                      'attached_services': [Service(**item) for item in data['attached_services']]})


@strawberry.type
class Query:
    @strawberry.field
    def templates(self) -> list[Template]:
        return [Template.from_data(item) for item in services.list_templates()]

    @strawberry.field
    def template(self, id: strawberry.ID) -> Template:
        try:
            return Template.from_data(services.get_template(str(id)))
        except services.TemplateNotFound as error:
            raise GraphQLError(str(error), extensions={'code': 'NOT_FOUND'}) from error

    @strawberry.field
    def model_configs(self) -> list[ModelConfig]:
        return [ModelConfig(**item) for item in services.list_model_configs()]

    @strawberry.field
    def services(self) -> list[Service]:
        return [Service(**item) for item in services.list_services()]


schema = strawberry.Schema(query=Query, extensions=[QueryDepthLimiter(max_depth=8)])
