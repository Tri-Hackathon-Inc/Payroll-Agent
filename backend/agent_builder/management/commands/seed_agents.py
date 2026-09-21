from django.core.management import call_command
from django.core.management.base import BaseCommand

from agent_builder.models import AgentBuilder


class Command(BaseCommand):
    help = 'Load the sample agents, but only when no agents exist yet.'

    def handle(self, *args, **options):
        if AgentBuilder.objects.exists():
            self.stdout.write('Agents already exist; skipping sample data.')
            return
        call_command('loaddata', 'sample_agents', verbosity=0)
        self.stdout.write(self.style.SUCCESS(f'Loaded {AgentBuilder.objects.count()} sample agents.'))
