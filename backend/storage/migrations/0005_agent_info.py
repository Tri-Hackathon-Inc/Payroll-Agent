from django.db import migrations, models


def snapshot_models(apps, schema_editor):
    alias = schema_editor.connection.alias
    Agent = apps.get_model("registry", "Agent")
    Model = apps.get_model("registry", "ModelConfiguration")
    models_by_id = {item["id"]: item for item in Model.objects.using(alias).values()}
    for agent in Agent.objects.using(alias).all().iterator():
        agent.model_config = models_by_id.get(agent.config.get("model"), {})
        agent.save(using=alias, update_fields=["model_config"])


class Migration(migrations.Migration):
    dependencies = [("registry", "0004_domain")]
    operations = [
        migrations.AlterModelTable(name="agent", table="agent_info"),
        migrations.AddField(
            model_name="agent", name="model_config", field=models.JSONField(default=dict),
        ),
        migrations.RunPython(snapshot_models, migrations.RunPython.noop),
    ]
