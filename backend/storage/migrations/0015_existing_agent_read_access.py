from django.db import migrations


def seed(apps, schema_editor):
    Agent = apps.get_model("registry", "Agent")
    Group = apps.get_model("registry", "AgentGroup")
    Member = apps.get_model("registry", "AgentGroupMembership")
    Role = apps.get_model("registry", "RoleGroup")
    Permission = apps.get_model("registry", "RoleGroupPermission")
    Authorization = apps.get_model("registry", "AgentAuthorization")
    Service = apps.get_model("registry", "ServiceDefinition")
    for agent in Agent.objects.select_related("domain").all():
        group = Group.objects.create(domain_id=agent.domain_id, name=f"Existing agent {agent.pk}")
        role = Role.objects.create(domain_id=agent.domain_id, name=f"Existing reader {agent.pk}")
        Member.objects.create(group=group, agent=agent)
        ids = {agent.config.get("service"), *agent.config.get("attached_services", [])}
        if ids.intersection({"payrun", "employee-details", "payrun-history"}):
            ids.update({"payrun", "employee-details", "payrun-history"})
        for service in Service.objects.filter(pk__in=ids, domain=agent.domain.domain, enabled=True, method__in=["GET", "HEAD"]):
            Permission.objects.create(role_group=role, service=service, read=True, write=False)
        Authorization.objects.create(agent_group=group, role_group=role)


class Migration(migrations.Migration):
    dependencies = [("registry", "0014_agentgroup_agentgroupmembership_agentgroup_agents_and_more")]
    operations = [migrations.RunPython(seed, migrations.RunPython.noop)]
