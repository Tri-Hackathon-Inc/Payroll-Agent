from django.db import migrations


class Migration(migrations.Migration):
    dependencies = [("registry", "0003_payroll_business")]
    operations = [
        migrations.RenameModel(old_name="Business", new_name="Domain"),
        migrations.RenameField(model_name="agent", old_name="business", new_name="domain"),
    ]
