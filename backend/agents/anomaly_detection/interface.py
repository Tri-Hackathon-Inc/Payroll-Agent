"""Transport-independent boundaries between detection and investigation."""
from abc import ABC, abstractmethod


class AnomalyDetectorInterface(ABC):
    @abstractmethod
    def detect(self, context, employee_id=None):
        """Calculate historical features and return evidence and suspicious findings."""


class AnomalyInvestigatorInterface(ABC):
    @abstractmethod
    def investigate(self, anomaly, monitor, agents, domain_name, context):
        """Investigate a detector result using configured agent action policies."""
