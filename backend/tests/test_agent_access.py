import os
from unittest.mock import patch
from django.test import TestCase
from agent_factory.factory import AgentFactory
from runtime import agent_access
from runtime.common import RuntimeFailure
from storage.models import Domain, AgentGroup, RoleGroup, RoleGroupPermission, AgentAuthorization, ServiceDefinition
from template import services
from tests.access_fixtures import grant_read


@patch.dict(os.environ, STUDIO_ADMIN_KEY="")
class AgentAccessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.get_or_create(name="payroll-services", defaults={"label":"Payroll", "domain":"Payroll"})
        Domain.objects.get_or_create(name="foreign", defaults={"label":"Other customer", "domain":"Payroll"})

    def setUp(self):
        self.agent = AgentFactory().create("payroll-services", "general-query", "Reader", {"model":"poc-demo"})
        self.definition = services.agent_data(self.agent)

    def manage(self, **body):
        return agent_access.manage({"domainName":"payroll-services", **body}, {}, write=True)

    def test_restore_payrun_reader_is_idempotent_and_read_only(self):
        from django.core.management import call_command
        call_command('restore_payrun_reader')
        call_command('restore_payrun_reader')
        group = AgentGroup.objects.get(domain_id='payroll-services', name='user-group')
        role = RoleGroup.objects.get(domain_id='payroll-services', name='payrun-reader')
        group.agents.add(self.agent)
        self.assertEqual(AgentAuthorization.objects.filter(agent_group=group, role_group=role).count(), 1)
        self.assertTrue(agent_access.allowed(self.definition, 'payrun', 'R', method='GET'))
        self.assertTrue(agent_access.allowed(self.definition, 'payrun', 'R', method='POST'))
        self.assertFalse(agent_access.allowed(self.definition, 'payrun', 'W', method='POST'))
        self.assertFalse(agent_access.allowed(self.definition, 'payrun', 'W', method='PUT'))

    def test_default_deny_and_independent_read_write(self):
        self.assertFalse(agent_access.allowed(self.definition, "payrun"))
        group, role = grant_read(self.agent)
        self.assertTrue(agent_access.can_read(self.definition))
        self.assertFalse(agent_access.allowed(self.definition, "payrun", "W"))
        RoleGroupPermission.objects.filter(role_group=role, service_id="payrun").update(read=False, write=True)
        self.assertFalse(agent_access.allowed(self.definition, "payrun", "R"))
        self.assertTrue(agent_access.allowed(self.definition, "payrun", "W"))
        self.assertFalse(agent_access.allowed(self.definition, "payrun", "DELETE"))

    def test_revocation_membership_and_disabled_service_take_effect_immediately(self):
        group, role = grant_read(self.agent)
        mapping = AgentAuthorization.objects.get(agent_group=group, role_group=role)
        self.manage(action="revoke", id=str(mapping.pk))
        self.assertFalse(agent_access.can_read(self.definition))
        self.manage(action="authorize", agentGroupId=str(group.pk), roleGroupId=str(role.pk))
        self.assertTrue(agent_access.can_read(self.definition))
        group.agents.remove(self.agent)
        self.assertFalse(agent_access.can_read(self.definition))
        group.agents.add(self.agent)
        ServiceDefinition.objects.filter(pk="payrun").update(enabled=False)
        self.assertFalse(agent_access.can_read(self.definition))

    def test_management_creates_memberships_roles_and_mapping(self):
        state = self.manage(action="agentGroup", name="Payroll agents", agentIds=[str(self.agent.pk)])
        group = state["agentGroups"][0]["id"]
        state = self.manage(action="roleGroup", name="Payroll readers", permissions=[{"service":s,"read":True,"write":False} for s in agent_access.read_services(self.definition)])
        role = state["roleGroups"][0]["id"]
        state = self.manage(action="authorize", agentGroupId=group, roleGroupId=role)
        self.assertEqual(len(state["authorizations"]), 1)
        self.assertTrue(agent_access.can_read(self.definition))
        self.manage(action="deleteRoleGroup", id=role)
        self.assertFalse(agent_access.can_read(self.definition))

    def test_cross_domain_and_invalid_updates_are_rejected_atomically(self):
        other = AgentFactory().create("foreign", "general-query", "Foreign", {"model":"poc-demo"})
        group, role = grant_read(self.agent)
        foreign_group, foreign_role = grant_read(other)
        for body in [dict(action="agentGroup",id=str(group.pk),name="Changed",agentIds=[str(other.pk)]),
                     dict(action="authorize",agentGroupId=str(group.pk),roleGroupId=str(foreign_role.pk)),
                     dict(action="roleGroup",id=str(role.pk),name="Changed",permissions=[{"service":"payrun","read":"yes","write":False}])]:
            with self.assertRaises(RuntimeFailure): self.manage(**body)
        group.refresh_from_db()
        self.assertNotEqual(group.name, "Changed")
        self.assertTrue(agent_access.can_read(self.definition))
        # Even malformed cross-domain DB relationships never grant access.
        AgentAuthorization.objects.all().delete()
        AgentAuthorization.objects.create(agent_group=group, role_group=foreign_role)
        self.assertFalse(agent_access.can_read(self.definition))
        self.assertFalse(agent_access.allowed({**self.definition,"domain_name":"foreign"}, "payrun"))

    def test_non_admin_cannot_manage_permissions(self):
        with patch.dict(os.environ, STUDIO_ADMIN_KEY="configured", USER_FEATURES="manageAgents"):
            with self.assertRaises(RuntimeFailure) as raised:
                agent_access.manage({"domainName":"payroll-services"}, {})
        self.assertEqual(raised.exception.status, 403)

    def test_denied_chat_does_not_read_source_or_invoke_model(self):
        from runtime.execution import execute
        with patch("runtime.execution.with_conversation", side_effect=lambda body, run: run({"context":body["context"]})), patch("runtime.execution.load_context") as read, patch("model.model.Model.generate") as model:
            with self.assertRaises(RuntimeFailure) as raised:
                execute({"domainName":"payroll-services","agentId":str(self.agent.pk),"question":"Explain bonus", "context":{"payrunId":"PR-1"}}, {"x-session-owner":"a"*64})
        self.assertEqual(raised.exception.status, 403)
        read.assert_not_called()
        model.assert_not_called()

    def test_denied_monitor_never_loads_payroll(self):
        from runtime.events import process
        ad = AgentFactory().create("payroll-services", "anomaly-detection", "AD", {"model":"poc-demo"})
        with patch("runtime.events.load_context") as read, patch("runtime.events.broadcast") as broadcast:
            process({"payrunId":"PR-1","domainName":"payroll-services"})
        read.assert_not_called()
        broadcast.assert_not_called()

    def test_denied_health_does_not_probe_service(self):
        from agents.health import agent_health
        with patch("agents.health.probe_service") as probe:
            result = agent_health({"domainName":"payroll-services"}, {})
        self.assertEqual(result["items"][0]["status"], "not_connected")
        self.assertIn("access", result["items"][0]["reason"])
        probe.assert_not_called()

    def test_existing_agent_migration_is_read_only_and_does_not_grant_future_agents(self):
        from importlib import import_module
        from django.apps import apps
        import_module("storage.migrations.0015_existing_agent_read_access").seed(apps, None)
        self.assertTrue(agent_access.can_read(self.definition))
        self.assertFalse(RoleGroupPermission.objects.filter(write=True).exists())
        newer = AgentFactory().create("payroll-services", "general-query", "New", {"model":"poc-demo"})
        self.assertFalse(agent_access.can_read(services.agent_data(newer)))

    def test_revoked_agent_cannot_replay_cached_session(self):
        from runtime.execution import execute
        group, role = grant_read(self.agent)
        group.agents.remove(self.agent)
        with patch("runtime.execution.with_conversation") as session:
            with self.assertRaises(RuntimeFailure):
                execute({"domainName":"payroll-services","agentId":str(self.agent.pk),"question":"Repeat", "sessionId":"a"*64}, {"x-session-owner":"b"*64})
        session.assert_not_called()

    def test_write_grant_without_service_attachment_is_denied(self):
        group, role = grant_read(self.agent)
        self.agent.config["attached_services"] = []
        self.agent.save()
        RoleGroupPermission.objects.create(role_group=role, service_id="email-notification", write=True)
        self.assertFalse(agent_access.allowed(services.agent_data(self.agent), "email-notification", "W"))

    def test_api_operations_and_methods_are_explicit(self):
        group, role = grant_read(self.agent)
        state = agent_access.snapshot(self.agent.domain)
        payrun = next(s for s in state["services"] if s["id"] == "payrun")
        self.assertEqual([(o["method"],o["access"]) for o in payrun["operations"]], [("GET","R"),("POST","W"),("POST","R"),("PUT","W")])
        self.assertTrue(agent_access.allowed(self.definition,"payrun","R",method="GET"))
        self.assertFalse(agent_access.allowed(self.definition,"payrun","R",method="DELETE"))
        self.assertFalse(agent_access.allowed(self.definition,"payrun","W",method="POST"))
        RoleGroupPermission.objects.filter(role_group=role,service_id="payrun").update(write=True)
        self.assertTrue(agent_access.allowed(self.definition,"payrun","W",method="POST"))

    def test_group_save_replaces_role_mappings_atomically(self):
        group, role = grant_read(self.agent)
        self.manage(action="agentGroup",id=str(group.pk),name=group.name,agentIds=[str(self.agent.pk)],roleGroupIds=[])
        self.assertFalse(agent_access.can_read(self.definition))
        self.manage(action="agentGroup",id=str(group.pk),name=group.name,agentIds=[str(self.agent.pk)],roleGroupIds=[str(role.pk)])
        self.assertTrue(agent_access.can_read(self.definition))
        with self.assertRaises(RuntimeFailure):
            self.manage(action="agentGroup",id=str(group.pk),name="Changed",agentIds=[],roleGroupIds=["999999"])
        self.assertTrue(agent_access.can_read(self.definition))

    def test_agent_and_group_assignments_are_saved_together(self):
        from storage.models import Agent
        group, role = grant_read(self.agent)
        save = lambda: services.create_agent("payroll-services","general-query","Grouped",{"model":"poc-demo"})
        saved = agent_access.save_agent_with_groups({"agentGroupIds":[str(group.pk)]},{},save)
        self.assertTrue(agent_access.can_read(saved))
        agent_access.save_agent_with_groups(None,{},lambda:services.update_agent(saved["id"],"payroll-services","Renamed",{}))
        self.assertTrue(agent_access.can_read(saved))
        agent_access.save_agent_with_groups({"agentGroupIds":[]},{},lambda:services.update_agent(saved["id"],"payroll-services","Renamed",{}))
        self.assertFalse(agent_access.can_read(saved))
        foreign = AgentGroup.objects.create(domain_id="foreign",name="Foreign")
        before = Agent.objects.count()
        with self.assertRaises(RuntimeFailure):
            agent_access.save_agent_with_groups({"agentGroupIds":[str(foreign.pk)]},{},save)
        self.assertEqual(Agent.objects.count(),before)
        with patch.dict(os.environ,STUDIO_ADMIN_KEY="configured"):
            with self.assertRaises(RuntimeFailure):
                agent_access.save_agent_with_groups({"agentGroupIds":[str(group.pk)]},{},save)
        self.assertEqual(Agent.objects.count(),before)

    def test_undefined_api_access_is_rejected(self):
        with self.assertRaises(RuntimeFailure):
            self.manage(action="roleGroup",name="Invalid",permissions=[{"service":"email-notification","read":True,"write":False}])
        self.assertFalse(RoleGroup.objects.filter(name="Invalid").exists())

    def test_direct_api_access_and_context_are_independent(self):
        from storage.models import AgentServicePermission, AgentContextPermission
        source = AgentFactory().create("payroll-services","anomaly-detection","AD source",{"model":"poc-demo"})
        payload = {"apiPermissions":[{"service":s,"read":True,"write":False} for s in agent_access.read_services(self.definition)],"contextSourceIds":[str(source.pk)]}
        agent_access.save_agent_with_groups(payload,{},lambda:self.definition)
        self.assertTrue(agent_access.can_read(self.definition))
        self.assertTrue(agent_access.can_read_context(self.agent.pk,source.pk,"payroll-services"))
        self.assertFalse(agent_access.can_read_context(source.pk,self.agent.pk,"payroll-services"))
        self.assertFalse(agent_access.can_read_context(self.agent.pk,source.pk,"foreign"))
        agent_access.save_agent_with_groups({"apiPermissions":[]},{},lambda:self.definition)
        self.assertFalse(agent_access.can_read(self.definition))
        self.assertTrue(agent_access.can_read_context(self.agent.pk,source.pk,"payroll-services"))
        agent_access.save_agent_with_groups({"contextSourceIds":[]},{},lambda:self.definition)
        self.assertFalse(agent_access.can_read_context(self.agent.pk,source.pk,"payroll-services"))

    def test_invalid_context_assignment_rolls_back_agent_and_api_edits(self):
        from storage.models import AgentServicePermission
        foreign = AgentFactory().create("foreign","general-query","Foreign context",{"model":"poc-demo"})
        for identifier in [str(foreign.pk),str(self.agent.pk),"not-an-id"]:
            with self.assertRaises(RuntimeFailure):
                agent_access.save_agent_with_groups({"apiPermissions":[{"service":"payrun","read":True,"write":False}],"contextSourceIds":[identifier]}, {}, lambda:services.update_agent(str(self.agent.pk),"payroll-services","Changed",{}))
        self.agent.refresh_from_db()
        self.assertEqual(self.agent.name,"Reader")
        self.assertFalse(AgentServicePermission.objects.filter(agent=self.agent).exists())

    def test_context_revocation_changes_session_authorization_scope(self):
        from runtime.execution import execute
        from storage.models import AgentContextPermission
        source = AgentFactory().create("payroll-services","anomaly-detection","AD source",{"model":"poc-demo"})
        grant = AgentContextPermission.objects.create(reader=self.agent,source=source)
        payload = {"domainName":"payroll-services","agentId":str(self.agent.pk),"question":"Hello"}
        with patch("runtime.execution.with_conversation",return_value={"reply":"Hello"}) as session:
            execute(payload,{"x-session-owner":"a"*64})
            before = session.call_args.args[0]["scope"]
            grant.delete()
            execute(payload,{"x-session-owner":"a"*64})
            after = session.call_args.args[0]["scope"]
        self.assertNotEqual(before["contextSources"],after["contextSources"])

    def test_direct_role_assignment_revoke_and_domain_validation(self):
        role = RoleGroup.objects.create(domain=self.agent.domain, name="Direct payroll reader")
        for service in ("payrun", "payrun-history", "employee-details"):
            RoleGroupPermission.objects.create(role_group=role, service_id=service, read=True)
        save = lambda: self.definition
        agent_access.save_agent_with_groups({"roleGroupIds":[str(role.pk)]}, {}, save)
        self.assertTrue(agent_access.can_read(self.definition))
        self.assertFalse(agent_access.allowed(self.definition, "payrun", "W"))
        self.assertEqual(agent_access.snapshot(self.agent.domain)["roleAssignments"],
                         [{"agentId":str(self.agent.pk), "roleGroupId":str(role.pk)}])
        agent_access.save_agent_with_groups({}, {}, save)
        self.assertTrue(agent_access.can_read(self.definition))
        foreign = RoleGroup.objects.create(domain_id="foreign", name="Foreign role")
        with self.assertRaises(RuntimeFailure):
            agent_access.save_agent_with_groups({"roleGroupIds":[str(foreign.pk)]}, {}, save)
        self.assertTrue(agent_access.can_read(self.definition))
        agent_access.save_agent_with_groups({"roleGroupIds":[]}, {}, save)
        self.assertFalse(agent_access.can_read(self.definition))
