from django.core.management.base import BaseCommand, CommandError
from agents.anomaly_detection.stream_models import AnomalyEvent


class Command(BaseCommand):
    help = "Retry one quarantined anomaly event, retaining its original evidence and features."

    def add_arguments(self, parser):
        parser.add_argument("event_id")

    def handle(self, *args, **options):
        changed = AnomalyEvent.objects.filter(pk=options["event_id"], status="failed").update(status="pending", attempts=0, lease_until=None)
        if not changed:
            raise CommandError("No failed event with that ID. Completed events are not automatically rescored.")
        self.stdout.write("Event queued for retry.")
