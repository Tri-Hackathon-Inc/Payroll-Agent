"""Run the durable record consumer independently of the API process."""
import time

from django.core.management.base import BaseCommand
from django.db import close_old_connections

from agents.anomaly_detection.streaming import drain_pending
from runtime.events import broadcast


class Command(BaseCommand):
    help = "Consume pending domain anomaly events. Safe to run multiple workers."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")

    def handle(self, *args, **options):
        try:
            while True:
                close_old_connections()
                count = drain_pending(broadcast=broadcast)
                if options["once"]:
                    self.stdout.write(f"Processed {count} events.")
                    return
                if not count:
                    time.sleep(1)
        except KeyboardInterrupt:
            pass
        finally:
            close_old_connections()
