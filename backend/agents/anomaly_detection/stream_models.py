"""Raw event archive and compact derived state, separate from review snapshots."""
from django.db import models


class AnomalyEvent(models.Model):
    id = models.CharField(primary_key=True, max_length=64)
    domain = models.ForeignKey("registry.Domain", on_delete=models.PROTECT)
    source_key = models.CharField(max_length=64)
    version = models.PositiveBigIntegerField()
    payload = models.JSONField()
    context = models.JSONField(null=True)
    status = models.CharField(max_length=20, default="pending")
    attempts = models.PositiveIntegerField(default=0)
    lease_until = models.DateTimeField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "registry"
        db_table = "anomaly_event"
        constraints = [models.UniqueConstraint(fields=["source_key", "version"], name="anomaly_event_version")]
        indexes = [models.Index(fields=["status", "lease_until"], name="anomaly_event_pending")]


class AnomalyRecord(models.Model):
    """Latest source version; a lock serializes revisions to the same record."""
    id = models.CharField(primary_key=True, max_length=64)
    version = models.PositiveBigIntegerField(default=0)
    event = models.ForeignKey(AnomalyEvent, null=True, on_delete=models.PROTECT)
    feature_keys = models.JSONField(default=list)

    class Meta:
        app_label = "registry"
        db_table = "anomaly_record"


class AnomalyFeatureState(models.Model):
    """One bounded numeric series per domain, tenant, metric, unit and dimensions."""
    id = models.CharField(primary_key=True, max_length=64)
    state = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "registry"
        db_table = "anomaly_feature_state"
