"""Domain-scoped agent service grants. No implicit permissions from attachment."""
from uuid import UUID
from django.db import transaction, IntegrityError
from django.core.exceptions import ValidationError
from storage.models import (AgentRoleAssignment, AgentServicePermission, AgentContextPermission, Agent, AgentGroup, AgentGroupMembership, RoleGroup,
                            RoleGroupPermission, AgentAuthorization, ServiceDefinition)
from runtime import access
from runtime.common import RuntimeFailure
from template.services import get_domain


def operations(service):
    return service.operations or [{"method": service.method, "path": service.path, "access": "R" if service.method in ("GET", "HEAD") else "W"}]


def allowed(definition, service, action="R", method=None):
    if action not in ("R", "W") or not service:
        return False
    try:
        identifier = UUID(str(definition.get("id")))
    except (ValueError, TypeError):
        return False
    domain = definition.get("domain_name")
    agent = Agent.objects.filter(pk=identifier, domain_id=domain).select_related("domain").first()
    if agent is None:
        return False
    # Payroll history and employee data are included in the primary payroll API.
    attached = {agent.config.get("service"), *agent.config.get("attached_services", [])}
    if attached.intersection({"payrun", "payrun-history", "employee-details"}):
        attached.update(("payrun", "payrun-history", "employee-details"))
    if service not in attached:
        return False
    api = ServiceDefinition.objects.filter(pk=service, enabled=True, domain=agent.domain.domain).first()
    if api is None or not any(op["access"] == action and (method is None or op["method"] == method) for op in operations(api)):
        return False
    if AgentServicePermission.objects.filter(agent=agent, service=api, **{"read" if action == "R" else "write": True}).exists():
        return True
    direct_roles = AgentRoleAssignment.objects.filter(agent=agent, role_group__domain_id=domain).values("role_group_id")
    if RoleGroupPermission.objects.filter(role_group_id__in=direct_roles, service=api,
            **{"read" if action == "R" else "write": True}).exists():
        return True
    roles = AgentAuthorization.objects.filter(
        agent_group__domain_id=domain, role_group__domain_id=domain,
        agent_group__agentgroupmembership__agent=agent).values("role_group_id")
    return RoleGroupPermission.objects.filter(role_group_id__in=roles,
        service_id=service, service__enabled=True, service__domain=agent.domain.domain,
        **{"read" if action == "R" else "write": True}).exists()


def require(definition, service, action="R"):
    if not allowed(definition, service, action):
        raise RuntimeFailure(f"Agent access denied: {action} permission is required for {service}. Ask an administrator to update Access control.", 403)


def read_services(definition):
    config = definition.get("config", {})
    primary = config.get("service")
    from agents.anomaly_detection.components import is_anomaly_agent
    if is_anomaly_agent(definition) and config.get("domain") == "Payroll":
        return ["payrun", "payrun-history", "employee-details"]
    return ["payrun", "payrun-history", "employee-details"] if primary in ("payrun", "employee-details", "payrun-history") else [primary]


def can_read(definition):
    return all(allowed(definition, service) for service in read_services(definition))


def require_read(definition):
    for service in read_services(definition):
        require(definition, service)


def snapshot(domain):
    return {
        "roleAssignments": [{"agentId": str(p.agent_id), "roleGroupId": str(p.role_group_id)} for p in AgentRoleAssignment.objects.filter(agent__domain=domain, role_group__domain=domain)],
        "apiPermissions": [{"agentId": str(p.agent_id), "service": p.service_id, "read": p.read, "write": p.write} for p in AgentServicePermission.objects.filter(agent__domain=domain)],
        "contextPermissions": [{"readerId": str(p.reader_id), "sourceId": str(p.source_id)} for p in AgentContextPermission.objects.filter(reader__domain=domain, source__domain=domain)],
        "agents": [{"id": str(a.pk), "name": a.name, "templateId": a.template_id} for a in Agent.objects.filter(domain=domain)],
        "services": [{"id": api.pk, "name": api.name, "operations": operations(api)} for api in ServiceDefinition.objects.filter(domain=domain.domain, enabled=True)],
        "agentGroups": [{"id": str(g.pk), "name": g.name, "agentIds": [str(a.pk) for a in g.agents.all()]} for g in AgentGroup.objects.filter(domain=domain).prefetch_related("agents")],
        "roleGroups": [{"id": str(g.pk), "name": g.name, "permissions": [{"service": p.service_id, "read": p.read, "write": p.write} for p in g.permissions.all()]} for g in RoleGroup.objects.filter(domain=domain).prefetch_related("permissions")],
        "authorizations": [{"id": str(a.pk), "agentGroupId": str(a.agent_group_id), "roleGroupId": str(a.role_group_id)} for a in AgentAuthorization.objects.filter(agent_group__domain=domain, role_group__domain=domain)]}


def manage(body, headers, *, write=False):
    user = access.require(headers, "manageAgents")
    if user["role"] != "admin":
        raise RuntimeFailure("Only administrators can manage agent permissions.", 403)
    domain = get_domain(body.get("domainName"))
    if not write:
        return snapshot(domain)
    try:
        with transaction.atomic():
            # Serialize edits within a domain, including membership replacement.
            type(domain).objects.select_for_update().get(pk=domain.pk)
            action = body.get("action")
            if action in ("agentGroup", "roleGroup"):
                name = body.get("name")
                if not isinstance(name, str) or not name.strip() or len(name.strip()) > 150:
                    raise RuntimeFailure("Enter a group name of 1-150 characters.", 400)
                model = AgentGroup if action == "agentGroup" else RoleGroup
                group = model.objects.get(pk=body["id"], domain=domain) if body.get("id") else model(domain=domain)
                group.name = name.strip()
                group.save()
                if action == "agentGroup":
                    ids = body.get("agentIds", [])
                    if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
                        raise RuntimeFailure("Agent IDs must be a list.", 400)
                    agents = list(Agent.objects.filter(domain=domain, pk__in=ids))
                    if len(agents) != len(set(ids)):
                        raise RuntimeFailure("All members must belong to this domain.", 400)
                    group.agents.set(agents)
                    if "roleGroupIds" in body:
                        ids = body["roleGroupIds"]
                        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
                            raise RuntimeFailure("Role group IDs must be a list.", 400)
                        roles = list(RoleGroup.objects.filter(domain=domain, pk__in=ids))
                        if len(roles) != len(set(ids)):
                            raise RuntimeFailure("Role groups must belong to this domain.", 400)
                        AgentAuthorization.objects.filter(agent_group=group).exclude(role_group__in=roles).delete()
                        for role in roles:
                            AgentAuthorization.objects.get_or_create(agent_group=group, role_group=role)
                else:
                    permissions = body.get("permissions", [])
                    if not isinstance(permissions, list):
                        raise RuntimeFailure("Permissions must be a list.", 400)
                    group.permissions.all().delete()
                    seen = set()
                    for item in permissions:
                        if not isinstance(item, dict) or type(item.get("read")) is not bool or type(item.get("write")) is not bool:
                            raise RuntimeFailure("Each permission requires read and write booleans.", 400)
                        service = item.get("service")
                        if not isinstance(service, str) or service in seen or not ServiceDefinition.objects.filter(pk=service, domain=domain.domain, enabled=True).exists():
                            raise RuntimeFailure("Choose distinct enabled services in this domain.", 400)
                        api = ServiceDefinition.objects.get(pk=service)
                        supported = {op["access"] for op in operations(api)}
                        if (item["read"] and "R" not in supported) or (item["write"] and "W" not in supported):
                            raise RuntimeFailure("This API does not define the requested operation.", 400)
                        seen.add(service)
                        RoleGroupPermission.objects.create(role_group=group, service_id=service, read=item["read"], write=item["write"])
            elif action == "authorize":
                group = AgentGroup.objects.get(pk=body.get("agentGroupId"), domain=domain)
                role = RoleGroup.objects.get(pk=body.get("roleGroupId"), domain=domain)
                AgentAuthorization.objects.get_or_create(agent_group=group, role_group=role)
            elif action == "revoke":
                AgentAuthorization.objects.get(pk=body.get("id"), agent_group__domain=domain, role_group__domain=domain).delete()
            elif action in ("deleteAgentGroup", "deleteRoleGroup"):
                model = AgentGroup if action == "deleteAgentGroup" else RoleGroup
                model.objects.get(pk=body.get("id"), domain=domain).delete()
            else:
                raise RuntimeFailure("Unknown access control action.", 400)
    except (AgentGroup.DoesNotExist, RoleGroup.DoesNotExist, AgentAuthorization.DoesNotExist, ValidationError, ValueError, TypeError, IntegrityError) as error:
        raise RuntimeFailure("Invalid group, duplicate name, or cross-domain access mapping.", 400) from error
    return snapshot(domain)


def require_payroll(definition):
    for service in ("payrun", "payrun-history", "employee-details"):
        require(definition, service)


@transaction.atomic
def save_agent_with_groups(body, headers, save):
    """Persist the agent and its memberships together; omitted groups remain unchanged."""
    groups = None
    if body is not None:
        user = access.require(headers, "manageAgents")
        if user["role"] != "admin":
            raise RuntimeFailure("Only administrators can assign access groups.", 403)
        ids = body.get("agentGroupIds", [])
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
            raise RuntimeFailure("Agent group IDs must be a list.", 400)
        groups = ids if "agentGroupIds" in body else None
    result = save()
    if groups is not None:
        domain = get_domain(result["domain_name"])
        type(domain).objects.select_for_update().get(pk=domain.pk)
        try:
            selected = list(AgentGroup.objects.filter(domain=domain, pk__in=groups))
        except (ValueError, TypeError, ValidationError) as error:
            raise RuntimeFailure("Invalid access group.", 400) from error
        if len(selected) != len(set(groups)):
            raise RuntimeFailure("Access groups must belong to the agent's domain.", 400)
        AgentGroupMembership.objects.filter(agent_id=result["id"]).exclude(group__in=selected).delete()
        for group in selected:
            AgentGroupMembership.objects.get_or_create(group=group, agent_id=result["id"])
    if body is not None:
        apply_direct_permissions(result, body)
    return result


def readable_sources(reader_id, domain):
    try:
        reader = UUID(str(reader_id))
    except (ValueError, TypeError):
        return []
    return list(AgentContextPermission.objects.filter(reader_id=reader, reader__domain_id=domain,
                source__domain_id=domain).order_by("source_id").values_list("source_id", flat=True))


def can_read_context(reader_id, source_id, domain):
    return str(source_id) in {str(value) for value in readable_sources(reader_id, domain)}


def apply_direct_permissions(agent, body):
    if "roleGroupIds" in body:
        ids = body["roleGroupIds"]
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
            raise RuntimeFailure("Role IDs must be a list.", 400)
        try:
            roles = list(RoleGroup.objects.filter(domain_id=agent["domain_name"], pk__in=ids))
        except (ValueError, TypeError, ValidationError) as error:
            raise RuntimeFailure("Invalid role selection.", 400) from error
        if len(roles) != len(set(ids)):
            raise RuntimeFailure("Roles must belong to the agent's domain.", 400)
        AgentRoleAssignment.objects.filter(agent_id=agent["id"]).exclude(role_group__in=roles).delete()
        for role in roles:
            AgentRoleAssignment.objects.get_or_create(agent_id=agent["id"], role_group=role)
    if "apiPermissions" in body:
        items = body["apiPermissions"]
        if not isinstance(items, list):
            raise RuntimeFailure("API permissions must be a list.", 400)
        AgentServicePermission.objects.filter(agent_id=agent["id"]).delete()
        seen = set()
        for item in items:
            if not isinstance(item, dict) or type(item.get("read")) is not bool or type(item.get("write")) is not bool:
                raise RuntimeFailure("API permissions require read and write booleans.", 400)
            service = item.get("service")
            if not isinstance(service, str) or service in seen:
                raise RuntimeFailure("Choose distinct service APIs.", 400)
            api = ServiceDefinition.objects.filter(pk=service, domain=agent["config"]["domain"], enabled=True).first()
            if api is None:
                raise RuntimeFailure("API is not available in this domain.", 400)
            supported = {op["access"] for op in operations(api)}
            if (item["read"] and "R" not in supported) or (item["write"] and "W" not in supported):
                raise RuntimeFailure("API operation is not supported.", 400)
            seen.add(service)
            AgentServicePermission.objects.create(agent_id=agent["id"], service=api, read=item["read"], write=item["write"])
    if "contextSourceIds" in body:
        ids = body["contextSourceIds"]
        if not isinstance(ids, list) or any(not isinstance(x, str) for x in ids):
            raise RuntimeFailure("Context source IDs must be a list.", 400)
        try:
            sources = list(Agent.objects.filter(pk__in=ids, domain_id=agent["domain_name"]).exclude(pk=agent["id"]))
        except (ValueError, ValidationError) as error:
            raise RuntimeFailure("Invalid context source.", 400) from error
        if len(sources) != len(set(ids)):
            raise RuntimeFailure("Choose other agents in this domain as context sources.", 400)
        AgentContextPermission.objects.filter(reader_id=agent["id"]).exclude(source__in=sources).delete()
        for source in sources:
            AgentContextPermission.objects.get_or_create(reader_id=agent["id"], source=source)

def chat_context_sources(definition):
    """Eligible same-service AD sources for General Query without payroll API grants."""
    if definition.get("template_id") != "general-query" or definition.get("config", {}).get("page") != "payrun":
        return []
    config = definition["config"]
    agents = Agent.objects.filter(domain_id=definition["domain_name"], template_id="anomaly-detection",
                                  pk__in=readable_sources(definition["id"], definition["domain_name"]))
    return [a.pk for a in agents if a.config.get("page") == "payrun" and a.config.get("service") == config.get("service")]
