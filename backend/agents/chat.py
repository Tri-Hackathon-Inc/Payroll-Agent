"""Rehydrate a saved agent and execute a single chat turn."""

from uuid import UUID

from model.model import Model
from model.runtime import ModelConfigurationError, ModelRuntimeFactory
from storage.models import Agent, ModelConfiguration
from template.services import InvalidInput, NotFound, get_domain


class AgentChat:
    def __init__(self, runtime_factory=None):
        self.runtime_factory = runtime_factory or ModelRuntimeFactory

    def reply(self, agent_id, domain_name, message, history=None):
        domain = get_domain(domain_name)
        try:
            identifier = UUID(str(agent_id))
        except ValueError as error:
            raise InvalidInput("agent_id must be a valid UUID.") from error
        try:
            agent = Agent.objects.get(pk=identifier, domain=domain)
        except Agent.DoesNotExist as error:
            raise NotFound("Agent not found in this domain.") from error
        if not isinstance(message, str) or not message.strip() or len(message) > 10000:
            raise InvalidInput("message must be nonempty text of at most 10000 characters.")
        history = [] if history is None else history
        if not isinstance(history, list) or len(history) > 40 or len(history) % 2:
            raise InvalidInput("history must contain at most 20 complete user/assistant turns.")
        for index, item in enumerate(history):
            if (not isinstance(item, dict) or set(item) != {"role", "content"}
                    or item["role"] != ("user" if index % 2 == 0 else "assistant")
                    or not isinstance(item["content"], str) or not item["content"].strip()
                    or len(item["content"]) > 10000):
                raise InvalidInput("history must contain alternating user and assistant text messages.")
        if sum(len(item["content"]) for item in history) + len(message) > 100000:
            raise InvalidInput("Conversation is too long. Start a new chat.")
        if not ModelConfiguration.objects.filter(pk=agent.config["model"], enabled=True).exists():
            raise ModelConfigurationError("The agent's model is no longer enabled in the catalog.")
        runtime = Model(agent.model_config, self.runtime_factory)
        messages = [
            {"role": "system", "content": agent.config["instructions"]},
            *history,
            {"role": "user", "content": message.strip()},
        ]
        return {
            "agent_id": str(agent.id),
            "model_id": agent.model_config["model_id"],
            "output": runtime.generate(messages),
            "demo": agent.model_config["provider"] == "demo",
        }
