from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class AgentInfoMigrationTests(TransactionTestCase):
    def test_existing_agents_and_model_details_survive(self):
        before = [("registry", "0004_domain")]
        after = [("registry", "0005_agent_info")]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        try:
            apps = executor.loader.project_state(before).apps
            domain = apps.get_model("registry", "Domain").objects.create(name="snapshot-test", label="Test", domain="Payroll")
            apps.get_model("registry", "ModelConfiguration").objects.create(
                id="migration-model", name="Saved model", provider="demo", model_id="saved-id", enabled=True,
            )
            agent = apps.get_model("registry", "Agent").objects.create(
                domain=domain, name="Existing", template_id="removed-template", template_version=2,
                config={"model": "migration-model", "created_by": "user", "service": "payrun"},
            )
            executor = MigrationExecutor(connection)
            executor.migrate(after)
            saved = executor.loader.project_state(after).apps.get_model("registry", "Agent").objects.get(pk=agent.pk)
            self.assertEqual(saved._meta.db_table, "agent_info")
            self.assertEqual(saved.config, agent.config)
            self.assertEqual(saved.created_at, agent.created_at)
            self.assertEqual(saved.model_config["model_id"], "saved-id")
            self.assertEqual(saved.model_config["name"], "Saved model")
        finally:
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
