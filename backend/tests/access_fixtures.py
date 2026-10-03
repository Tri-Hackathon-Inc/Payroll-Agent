"""Explicit grants for tests exercising authorized agent workflows."""
from storage.models import AgentGroup, RoleGroup, RoleGroupPermission, AgentAuthorization
from runtime.agent_access import read_services
from template.services import agent_data


def grant_read(agent):
    group, _ = AgentGroup.objects.get_or_create(domain=agent.domain, name=f"Test {agent.pk}")
    group.agents.add(agent)
    role, _ = RoleGroup.objects.get_or_create(domain=agent.domain, name=f"Test {agent.pk}")
    for service in read_services(agent_data(agent)):
        RoleGroupPermission.objects.update_or_create(role_group=role, service_id=service, defaults={"read": True})
    AgentAuthorization.objects.get_or_create(agent_group=group, role_group=role)
    return group, role
