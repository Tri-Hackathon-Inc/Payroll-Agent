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
    # Display metadata for the model library: license, description, context window, etc.
    details = models.JSONField(default=dict, blank=True)


class ServiceDefinition(models.Model):
    id = models.SlugField(primary_key=True, max_length=100)
    name = models.CharField(max_length=150)
    domain = models.CharField(max_length=100)
    enabled = models.BooleanField(default=True)
    base_url_env = models.CharField(max_length=150)
    method = models.CharField(max_length=10)
    path = models.CharField(max_length=500)
    operations = models.JSONField(default=list, blank=True)


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
    # Models this template offers; empty means every enabled model.
    supported_models = models.ManyToManyField(
        ModelConfiguration, blank=True, related_name="supporting_templates"
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
    model_config = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "agent_info"
        ordering = ["created_at", "id"]


class AgentGroup(models.Model):
    domain = models.ForeignKey(Domain, on_delete=models.CASCADE)
    name = models.CharField(max_length=150)
    agents = models.ManyToManyField(Agent, through="AgentGroupMembership")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["domain", "name"], name="unique_agent_group")]


class AgentGroupMembership(models.Model):
    group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE)
    agent = models.ForeignKey(Agent, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["group", "agent"], name="unique_agent_membership")]


class RoleGroup(models.Model):
    domain = models.ForeignKey(Domain, on_delete=models.CASCADE)
    name = models.CharField(max_length=150)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["domain", "name"], name="unique_role_group")]


class RoleGroupPermission(models.Model):
    role_group = models.ForeignKey(RoleGroup, on_delete=models.CASCADE, related_name="permissions")
    service = models.ForeignKey(ServiceDefinition, on_delete=models.CASCADE)
    read = models.BooleanField(default=False)
    write = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["role_group", "service"], name="unique_role_service")]


class AgentAuthorization(models.Model):
    agent_group = models.ForeignKey(AgentGroup, on_delete=models.CASCADE)
    role_group = models.ForeignKey(RoleGroup, on_delete=models.CASCADE)

    class Meta:
        db_table = "agent_authorization"
        constraints = [models.UniqueConstraint(fields=["agent_group", "role_group"], name="unique_agent_authorization")]


class AgentRoleAssignment(models.Model):
    agent = models.ForeignKey(Agent, on_delete=models.CASCADE)
    role_group = models.ForeignKey(RoleGroup, on_delete=models.CASCADE)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["agent", "role_group"], name="unique_direct_agent_role")]


class AgentServicePermission(models.Model):
    agent = models.ForeignKey(Agent, on_delete=models.CASCADE)
    service = models.ForeignKey(ServiceDefinition, on_delete=models.CASCADE)
    read = models.BooleanField(default=False)
    write = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["agent", "service"], name="unique_direct_agent_api")]


class AgentContextPermission(models.Model):
    reader = models.ForeignKey(Agent, on_delete=models.CASCADE, related_name="readable_contexts")
    source = models.ForeignKey(Agent, on_delete=models.CASCADE, related_name="context_readers")

    class Meta:
        constraints = [models.UniqueConstraint(fields=["reader", "source"], name="unique_agent_context_read"),
                       models.CheckConstraint(condition=~models.Q(reader=models.F("source")), name="no_self_context_grant")]


class AgentMessage(models.Model):
    id = models.CharField(primary_key=True, max_length=64)
    domain = models.ForeignKey(Domain, on_delete=models.PROTECT)
    sender_id = models.UUIDField()
    recipient_id = models.UUIDField()
    service = models.CharField(max_length=100)
    capability = models.CharField(max_length=100)
    source_reference = models.CharField(max_length=100)
    source_version = models.PositiveBigIntegerField()
    requested_by = models.CharField(max_length=64)
    status = models.CharField(max_length=20)
    result = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class AgentInteraction(models.Model):
    """One question answered by an agent, recorded for the admin metrics view.

    Holds measurements only (how the answer was produced, latency, tokens, checks, findings,
    incidents, feedback); never model credentials or full payroll data.
    """

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    domain = models.ForeignKey(Domain, on_delete=models.CASCADE, related_name="interactions")
    # Agents can be edited or removed later; the ID and a name snapshot keep history readable.
    agent_id = models.UUIDField(db_index=True)
    agent_name = models.CharField(max_length=150)
    template_id = models.CharField(max_length=100, blank=True)
    source = models.CharField(max_length=60, blank=True)
    session_id = models.CharField(max_length=100, blank=True)
    payrun_id = models.CharField(max_length=100, blank=True)
    question = models.CharField(max_length=500)
    answered_by = models.CharField(max_length=40)
    intent = models.CharField(max_length=60, blank=True)
    model_id = models.CharField(max_length=100, blank=True)
    latency_ms = models.PositiveIntegerField(default=0)
    model_latency_ms = models.PositiveIntegerField(null=True)
    prompt_tokens = models.PositiveIntegerField(null=True)
    completion_tokens = models.PositiveIntegerField(null=True)
    cached = models.BooleanField(default=False)
    check_status = models.CharField(max_length=20, blank=True)
    unverified_count = models.PositiveIntegerField(default=0)
    findings = models.JSONField(default=dict)
    amount_at_risk = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    incident_id = models.CharField(max_length=100, blank=True)
    suggested_count = models.PositiveIntegerField(default=0)
    error = models.CharField(max_length=300, blank=True)
    feedback = models.CharField(max_length=10, blank=True)
    feedback_at = models.DateTimeField(null=True)
    # Fingerprint of the reply text: the same question getting different answers shows up in
    # the consistency metric. The reply itself is not stored.
    answer_hash = models.CharField(max_length=32, blank=True)

    class Meta:
        db_table = "agent_interaction"
        ordering = ["-created_at"]


# Register agent-owned persistence with the existing Django application.
from agents.anomaly_detection.models import AnomalyCase, AnomalyFeatures, AnomalyAudit
from agents.anomaly_detection.stream_models import AnomalyEvent, AnomalyRecord, AnomalyFeatureState
