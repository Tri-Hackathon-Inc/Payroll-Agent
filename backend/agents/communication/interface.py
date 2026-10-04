"""Transport-independent contracts for all participating agent types."""
from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class ResponseContext:
    reference: str
    version: int
    entity_type: str
    entity_id: str
    response: dict
    evidence: dict


@dataclass(frozen=True)
class Receiver:
    template_id: str
    entity_types: tuple[str, ...]
    receive: Callable
    version: int = 1
