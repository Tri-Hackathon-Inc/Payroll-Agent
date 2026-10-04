from abc import ABC, abstractmethod


class AgentInterface(ABC):
    @abstractmethod
    def respond(self, question, context, conversation, confirmation=None):
        """Return a completed answer or an intermediate query-selection result."""
