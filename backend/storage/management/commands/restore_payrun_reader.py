"""Explicitly restore the payroll reader group and role without granting writes."""
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from storage.models import Domain, AgentGroup, RoleGroup, RoleGroupPermission, AgentAuthorization
from template.services import sync_templates


class Command(BaseCommand):
    help = 'Restore user-group and payrun-reader with payroll API Read permissions.'

    def add_arguments(self, parser):
        parser.add_argument('--domain', default='payroll-services')

    @transaction.atomic
    def handle(self, *args, **options):
        sync_templates()
        try:
            domain = Domain.objects.get(pk=options['domain'], domain='Payroll')
        except Domain.DoesNotExist:
            raise CommandError('A Payroll domain is required.') from None
        group, _ = AgentGroup.objects.get_or_create(domain=domain, name='user-group')
        role, _ = RoleGroup.objects.get_or_create(domain=domain, name='payrun-reader')
        for service in ('payrun', 'payrun-history', 'employee-details'):
            RoleGroupPermission.objects.update_or_create(role_group=role, service_id=service,
                                                        defaults={'read': True, 'write': False})
        AgentAuthorization.objects.get_or_create(agent_group=group, role_group=role)
        self.stdout.write('Restored user-group -> payrun-reader (Read only). Existing memberships preserved.')
