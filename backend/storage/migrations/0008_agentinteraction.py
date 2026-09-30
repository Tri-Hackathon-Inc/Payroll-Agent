import uuid

import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("registry", "0007_merge_agent_info_models"),
    ]

    operations = [
        migrations.CreateModel(
            name="AgentInteraction",
            fields=[
                ("id", models.UUIDField(default=uuid.uuid4, editable=False, primary_key=True, serialize=False)),
                ("created_at", models.DateTimeField(auto_now_add=True, db_index=True)),
                ("agent_id", models.UUIDField(db_index=True)),
                ("agent_name", models.CharField(max_length=150)),
                ("template_id", models.CharField(blank=True, max_length=100)),
                ("source", models.CharField(blank=True, max_length=60)),
                ("session_id", models.CharField(blank=True, max_length=100)),
                ("payrun_id", models.CharField(blank=True, max_length=100)),
                ("question", models.CharField(max_length=500)),
                ("answered_by", models.CharField(max_length=40)),
                ("intent", models.CharField(blank=True, max_length=60)),
                ("model_id", models.CharField(blank=True, max_length=100)),
                ("latency_ms", models.PositiveIntegerField(default=0)),
                ("model_latency_ms", models.PositiveIntegerField(null=True)),
                ("prompt_tokens", models.PositiveIntegerField(null=True)),
                ("completion_tokens", models.PositiveIntegerField(null=True)),
                ("cached", models.BooleanField(default=False)),
                ("check_status", models.CharField(blank=True, max_length=20)),
                ("unverified_count", models.PositiveIntegerField(default=0)),
                ("findings", models.JSONField(default=dict)),
                ("amount_at_risk", models.DecimalField(decimal_places=2, default=0, max_digits=14)),
                ("incident_id", models.CharField(blank=True, max_length=100)),
                ("suggested_count", models.PositiveIntegerField(default=0)),
                ("error", models.CharField(blank=True, max_length=300)),
                ("feedback", models.CharField(blank=True, max_length=10)),
                ("feedback_at", models.DateTimeField(null=True)),
                ("domain", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="interactions", to="registry.domain")),
            ],
            options={"db_table": "agent_interaction", "ordering": ["-created_at"]},
        ),
    ]
