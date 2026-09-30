from django.apps import AppConfig


class StorageConfig(AppConfig):
    name = "storage"
    # Keep existing table names, relation labels and applied migration history.
    label = "registry"
    verbose_name = "Agent storage"
