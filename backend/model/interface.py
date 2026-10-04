from abc import ABC, abstractmethod


class ModelInterface(ABC):
    @abstractmethod
    def generate(self, messages, response_format=None):
        """Generate text from prepared messages using a request-local provider client."""
