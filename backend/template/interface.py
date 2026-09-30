from abc import ABC, abstractmethod


class TemplateInterface(ABC):
    @abstractmethod
    def configure(self, template_id, overrides):
        """Resolve template metadata and effective configuration."""
