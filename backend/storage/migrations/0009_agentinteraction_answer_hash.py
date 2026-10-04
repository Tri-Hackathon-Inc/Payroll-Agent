from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("registry", "0008_agentinteraction"),
    ]

    operations = [
        migrations.AddField(
            model_name="agentinteraction",
            name="answer_hash",
            field=models.CharField(blank=True, max_length=32),
        ),
    ]
