from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class DomainMigrationTests(TransactionTestCase):
    def test_existing_group_and_agent_survive_rename(self):
        old = [("registry", "0003_payroll_business")]
        new = [("registry", "0004_domain")]
        executor = MigrationExecutor(connection)
        executor.migrate(old)
        try:
            apps = executor.loader.project_state(old).apps
            group = apps.get_model("registry", "Business").objects.create(
                name="migration-payroll", label="Migration Payroll", domain="Payroll"
            )
            agent = apps.get_model("registry", "Agent").objects.create(
                business=group, name="Existing agent", template_id="anomaly-detection",
                template_version=1, config={"model": "preserved", "service": "payrun"},
            )
            executor = MigrationExecutor(connection)
            executor.migrate(new)
            apps = executor.loader.project_state(new).apps
            saved = apps.get_model("registry", "Agent").objects.get(pk=agent.pk)
            self.assertEqual(saved.domain_id, "migration-payroll")
            self.assertEqual(saved.config, agent.config)
            self.assertEqual(saved.created_at, agent.created_at)
            self.assertTrue(apps.get_model("registry", "Domain").objects.filter(pk=group.pk).exists())
        finally:
            MigrationExecutor(connection).migrate(new)
