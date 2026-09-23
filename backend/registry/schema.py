import strawberry
from strawberry.extensions import QueryDepthLimiter
from strawberry.scalars import JSON

from graphql import GraphQLError

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
    model_options: list[ModelConfig]
    service_options: list[Service]

    @classmethod
    def from_data(cls, data):
        return cls(
            **{
                **data,
                "model_config": ModelConfig(**data["model_config"]),
                "service": Service(**data["service"]),
                "attached_services": [
                    Service(**item) for item in data["attached_services"]
                ],
                "model_options": [
                    ModelConfig(**item) for item in data.get("model_options", [])
                ],
                "service_options": [
                    Service(**item) for item in data.get("service_options", [])
                ],
            }
        )


@strawberry.type
class Business:
    name: str
    label: str
    domain: str


@strawberry.type
class Agent:
    id: strawberry.ID
    name: str
    business_name: str
    template_id: str
    template_version: int
    config: JSON
    created_at: str
    updated_at: str


@strawberry.input
class CreateAgentInput:
    business_name: str
    template_id: str
    name: str
    config: JSON


@strawberry.input
class UpdateAgentInput:
    id: strawberry.ID
    business_name: str
    name: str
    config: JSON


def call_service(operation, *args):
    try:
        return operation(*args)
    except services.NotFound as error:
        raise GraphQLError(str(error), extensions={"code": "NOT_FOUND"}) from error
    except services.InvalidInput as error:
        raise GraphQLError(str(error), extensions={"code": "BAD_USER_INPUT"}) from error


@strawberry.type
class Query:
    @strawberry.field
    def templates(self) -> list[Template]:
        return [Template.from_data(item) for item in services.list_templates()]

    @strawberry.field
    def template(self, id: strawberry.ID) -> Template:
        return Template.from_data(call_service(services.get_template, str(id)))

    @strawberry.field
    def businesses(self) -> list[Business]:
        return [Business(**item) for item in services.list_businesses()]

    @strawberry.field
    def business_agents(self, business_name: str) -> list[Agent]:
        return [
            Agent(**item)
            for item in call_service(services.get_business_agents, business_name)
        ]


@strawberry.type
class Mutation:
    @strawberry.mutation
    def create_agent(self, input: CreateAgentInput) -> Agent:
        return Agent(
            **call_service(
                services.create_agent,
                input.business_name,
                input.template_id,
                input.name,
                input.config,
            )
        )

    @strawberry.mutation
    def update_agent(self, input: UpdateAgentInput) -> Agent:
        return Agent(
            **call_service(
                services.update_agent,
                str(input.id),
                input.business_name,
                input.name,
                input.config,
            )
        )


schema = strawberry.Schema(
    query=Query, mutation=Mutation, extensions=[QueryDepthLimiter(max_depth=8)]
)
