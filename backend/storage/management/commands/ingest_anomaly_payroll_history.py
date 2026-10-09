"""One-time/resumable backfill of compact features, independent of the LLM/RAG path."""
import json
import os

from django.core.management.base import BaseCommand, CommandError

from agents.anomaly_detection.domains.payroll_records import payrun_events
from agents.anomaly_detection.streaming import accept, prepare
from agents.anomaly_detection.stream_models import AnomalyEvent
from runtime.common import RuntimeFailure, request_json
from runtime.payroll import PAYRUN_FIELDS
from template import services


class Command(BaseCommand):
    help = "Backfill finalized payroll measurements into the reusable rolling feature store. No model calls."

    def add_arguments(self, parser):
        parser.add_argument("--domain", required=True)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        services.get_domain(options["domain"])
        try:
            response = request_json(os.environ["TRINET_API_URL"],
                                    {"query": "query { payruns(status: COMPLETED) { " + PAYRUN_FIELDS + " } }"}, timeout=30)
            runs = response.get("data", {}).get("payruns")
            if response.get("errors") or not isinstance(runs, list):
                raise ValueError("Invalid source response")
            # Validate every payload before the first write. Ordered replay makes
            # prior feature snapshots deterministic during initial ingestion.
            batches = [payrun_events(run, options["domain"]) for run in sorted(runs, key=lambda item: (item["payDate"], item["id"]))
                       if run.get("status") == "COMPLETED"]
            events = [event for batch in batches for event in batch]
            if not options["dry_run"]:
                for event in events:
                    result = accept(event, backfill=True)
                    if result["status"] == "backfill":
                        # Backfill only establishes historical state. It does not
                        # create historical review cards or invoke investigation.
                        prepare(result["eventId"])
                        AnomalyEvent.objects.filter(pk=result["eventId"], status="backfill").update(status="completed")
            self.stdout.write(json.dumps({"payruns": len(batches), "records": len(events), "dryRun": options["dry_run"]}))
        except (RuntimeFailure, ValueError, KeyError, TypeError) as error:
            raise CommandError("Feature ingestion failed. Check the source records and payroll endpoint; rerunning preserves existing events.") from error
