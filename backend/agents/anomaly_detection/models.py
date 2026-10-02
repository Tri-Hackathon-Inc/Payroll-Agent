"""Persisted anomaly evidence and human review state owned by this agent."""
from django.db import models
import uuid


class AnomalyCase(models.Model):
    id = models.CharField(primary_key=True, max_length=64)
    domain = models.ForeignKey("registry.Domain", on_delete=models.PROTECT)
    agent_id = models.UUIDField()
    agent_name = models.CharField(max_length=150)
    entity_type = models.CharField(max_length=60, default="payrun")
    payrun_id = models.CharField(max_length=100)
    payrun_version = models.PositiveBigIntegerField()
    detector_version = models.CharField(max_length=50)
    decision = models.CharField(max_length=16)
    summary = models.TextField()
    snapshot = models.JSONField()
    review_status = models.CharField(max_length=20, default="pending")
    review_token = models.UUIDField(null=True)
    review_started_at = models.DateTimeField(null=True)
    reviewed_at = models.DateTimeField(null=True)
    reviewer_hash = models.CharField(max_length=64, blank=True)
    investigation = models.JSONField(null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "registry"
        db_table = "anomaly_case"
        ordering = ["-payrun_version", "-created_at"]
        indexes = [models.Index(fields=["domain", "payrun_id", "agent_id"], name="anomaly_scope_idx")]


class AnomalyFeatures(models.Model):
    namespace = models.CharField(max_length=160)
    key = models.CharField(max_length=64)
    features = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "registry"
        db_table = "anomaly_features"
        constraints = [models.UniqueConstraint(fields=["namespace", "key"], name="anomaly_feature_key")]


class AnomalyAudit(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    case = models.ForeignKey(AnomalyCase, on_delete=models.PROTECT, related_name="audit")
    action = models.CharField(max_length=40)
    reviewer_hash = models.CharField(max_length=64)
    request_id = models.UUIDField(default=uuid.uuid4)
    details = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        app_label = "registry"
        db_table = "anomaly_audit"
        constraints = [models.UniqueConstraint(fields=["case", "request_id"], name="anomaly_audit_request")]
