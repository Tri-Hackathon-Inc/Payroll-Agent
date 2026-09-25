import uuid

from django.db import models


class ModelConfiguration(models.Model):
    id = models.SlugField(primary_key=True, max_length=100)
    name = models.CharField(max_length=150)
    provider = models.CharField(max_length=100)
    model_id = models.CharField(max_length=255)
    enabled = models.BooleanField(default=False)
    endpoint_env = models.CharField(max_length=150, blank=True)
    credential_env = models.CharField(max_length=150, blank=True)
    parameters = models.JSONField(default=dict)


class ServiceDefinition(models.Model):
    id = models.SlugField(primary_key=True, max_length=100)
    name = models.CharField(max_length=150)
    domain = models.CharField(max_length=100)
    enabled = models.BooleanField(default=True)
    base_url_env = models.CharField(max_length=150)
    method = models.CharField(max_length=10)
    path = models.CharField(max_length=500)


class Template(models.Model):
    id = models.SlugField(primary_key=True, max_length=100)
    name = models.CharField(max_length=150)
    description = models.TextField()
    version = models.PositiveIntegerField()
    config = models.JSONField()
    default_model = models.ForeignKey(ModelConfiguration, on_delete=models.PROTECT)
    service = models.ForeignKey(
        ServiceDefinition, on_delete=models.PROTECT, related_name="templates"
    )
    attached_services = models.ManyToManyField(
        ServiceDefinition, related_name="attached_templates"
    )

    class Meta:
        ordering = ["id"]


class Domain(models.Model):
    name = models.SlugField(primary_key=True, max_length=100)
    label = models.CharField(max_length=150)
    domain = models.CharField(max_length=100)

    class Meta:
        ordering = ["name"]


class Agent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    domain = models.ForeignKey(
        Domain, on_delete=models.PROTECT, related_name="agents"
    )
    name = models.CharField(max_length=150)
    # Provenance is a snapshot: catalog synchronization must not delete agents.
    template_id = models.CharField(max_length=100)
    template_version = models.PositiveIntegerField()
    config = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at", "id"]
