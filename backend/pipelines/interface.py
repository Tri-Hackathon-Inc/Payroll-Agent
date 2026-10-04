from abc import ABC, abstractmethod


class QueryPipelineInterface(ABC):
    @abstractmethod
    def prepare(self, agent, domain_name, invocation, conversation, question, **dependencies):
        """Prepare grounded model input or return an early clarification."""


class ResponsePipelineInterface(ABC):
    @abstractmethod
    def process(self, evidence, sources, output):
        """Validate a model result against source evidence and format its response."""
