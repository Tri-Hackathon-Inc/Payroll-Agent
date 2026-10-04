from abc import ABC, abstractmethod


class AgentFactoryInterface(ABC):
    @abstractmethod
    def create(self, domain_name, template_id, name, config):
        """Validate and persist an agent definition without invoking a model."""

    @abstractmethod
    def load(self, domain_name, agent_id, runtime_factory=None):
        """Rehydrate a domain-scoped runtime agent from its persisted definition."""
