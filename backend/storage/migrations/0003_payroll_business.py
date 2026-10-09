from django.db import migrations


def seed_business(apps, schema_editor):
    apps.get_model("registry", "Business").objects.using(
        schema_editor.connection.alias
    ).get_or_create(
        name="payroll-services",
        defaults={"label": "Payroll Services", "domain": "Payroll"},
    )


class Migration(migrations.Migration):
    dependencies = [("registry", "0002_business_agent")]
    operations = [migrations.RunPython(seed_business, migrations.RunPython.noop)]
