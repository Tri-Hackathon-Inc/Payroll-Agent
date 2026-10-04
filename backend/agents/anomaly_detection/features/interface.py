"""Feature storage and calculation contracts, independent of a database or domain."""
from typing import Protocol


class FeatureStoreInterface(Protocol):
    def get(self, namespace: str, key: str): ...
    def put(self, namespace: str, key: str, features: dict): ...


class FeatureEnricherInterface(Protocol):
    version: str
    def enrich(self, context: dict, scope=None) -> dict: ...
