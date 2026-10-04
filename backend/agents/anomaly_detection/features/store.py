"""Immutable feature snapshots. Remote stores can implement the same two methods."""
from copy import deepcopy


class DatabaseFeatureStore:
    def get(self, namespace, key):
        from ..models import AnomalyFeatures
        record = AnomalyFeatures.objects.filter(namespace=namespace, key=key).first()
        return deepcopy(record.features) if record else None

    def put(self, namespace, key, features):
        from ..models import AnomalyFeatures
        AnomalyFeatures.objects.get_or_create(namespace=namespace, key=key, defaults={"features": deepcopy(features)})


class MemoryFeatureStore:
    """Isolated transient store useful for embedded use and contract tests."""
    def __init__(self):
        self.records = {}

    def get(self, namespace, key):
        return deepcopy(self.records.get((namespace, key)))

    def put(self, namespace, key, features):
        self.records.setdefault((namespace, key), deepcopy(features))


class NoFeatureStore:
    def get(self, namespace, key):
        return None

    def put(self, namespace, key, features):
        pass
