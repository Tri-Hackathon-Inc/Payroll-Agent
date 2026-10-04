"""Evidence tools are read-only, domain-bound and invoked after human Review."""
from typing import Protocol


class EvidenceToolsInterface(Protocol):
    def collect(self, context: dict, detection: dict) -> list[dict]: ...
