import json
import os
from datetime import date, timedelta

from django.core.management.base import BaseCommand, CommandError
from template import services
from runtime.common import RuntimeFailure, request_json, valid_date
from runtime.payroll import PAYRUN_FIELDS, preprocess
from runtime.retrieval import LocalEmbeddings, VectorStore, history_documents


class Command(BaseCommand):
    help = "Idempotently index completed payroll history with local Python embeddings."

    def add_arguments(self, parser):
        parser.add_argument("--domain", required=True)
        parser.add_argument("--service", required=True)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        services.get_domain(options["domain"])
        if not options["service"].strip():
            raise CommandError("A service identifier is required.")
        try:
            result = request_json(os.environ["TRINET_API_URL"], {"query": "query { payruns(status: COMPLETED) { " + PAYRUN_FIELDS + " } }"}, timeout=30)
            runs = result.get("data", {}).get("payruns")
            if result.get("errors") or not isinstance(runs, list):
                raise ValueError("Invalid payroll response")
            seen, batches = set(), []
            for run in runs:
                if run.get("status") != "COMPLETED" or run.get("id") in seen:
                    continue
                seen.add(run.get("id"))
                preprocess(run, [])
                if not valid_date(run.get("periodEnd")):
                    raise ValueError("Invalid completed period")
                # Reuse the same document construction as query retrieval, without
                # including a synthetic record in the index.
                after = (date.fromisoformat(max(run["periodEnd"], run["payDate"]))+timedelta(days=1)).isoformat()
                current = {**run, "id": "ingestion-boundary", "periodStart": after, "payDate": after}
                batches.append(history_documents({"current": current, "history": [run]}, options["domain"], options["service"]))
            summary = {"payruns": len(batches), "documents": sum(map(len, batches)), "inserted": 0, "existing": 0, "dryRun": options["dry_run"], "embeddingModel": LocalEmbeddings.version}
            if not options["dry_run"]:
                store = VectorStore()
                for documents in batches:
                    counts = store.index(documents)
                    for key in ("inserted", "existing"):
                        summary[key] += counts[key]
            self.stdout.write(json.dumps(summary))
        except (RuntimeFailure, ValueError, KeyError) as error:
            raise CommandError("History indexing failed. Check the payroll endpoint, source records, PostgreSQL and model cache; rerunning resumes existing documents.") from error
