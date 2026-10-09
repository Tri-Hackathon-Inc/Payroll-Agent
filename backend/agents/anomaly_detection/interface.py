"""Transport-independent boundaries between detection and investigation."""
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class EntityReference:
    kind: str
    identity: str
    version: int
    tenant: str


class DomainInterface(Protocol):
    def reference(self, context) -> EntityReference: ...
    def load(self, invocation): ...
    def invocation(self, reference: EntityReference): ...
    def selected(self, invocation): ...
    def scope(self, invocation): ...
    def event_details(self, event, detection): ...
    def record_review(self, definition, case, result, elapsed): ...


class AnomalyDetectorInterface(ABC):
    @abstractmethod
    def detect(self, context, employee_id=None):
        """Calculate historical features and return evidence and suspicious findings."""


class AnomalyInvestigatorInterface(ABC):
    @abstractmethod
    def investigate(self, definition, context, detection, *, model, tools):
        """Explain findings through domain validation, only after human Review."""


class DecisionModelInterface(Protocol):
    version: str

    def score(self, features: dict) -> dict:
        """Return decision and score from prepared features, without loading history."""


class DetectionRuleInterface(Protocol):
    def evaluate(self, measurement: dict) -> dict | None:
        """Return a calculated signal or None for a measurement in this domain."""
