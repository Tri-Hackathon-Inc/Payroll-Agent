from tests.access_fixtures import grant_read
"""Domain-neutral ingestion, time-safe baselines, recovery, and grounded Review."""
from copy import deepcopy
from datetime import timedelta
import json
import os
from pathlib import Path
from statistics import mean, variance
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TestCase
from django.utils import timezone

from agent_factory.factory import AgentFactory
from agents.anomaly_detection.agent import AnomalyDetectionAgent, list_anomalies
from agents.anomaly_detection.domains.records import RecordEvidenceTools, RecordInvestigator
from agents.anomaly_detection.features.rolling import RollingFeatures, WINDOW_SIZE
from agents.anomaly_detection.models import AnomalyCase
from agents.anomaly_detection.records import feature_key, source_key, validate_record_event
from agents.anomaly_detection.scoring import RangeRule, RecordDetector
from agents.anomaly_detection.stream_models import AnomalyEvent, AnomalyFeatureState, AnomalyRecord
from agents.anomaly_detection.streaming import accept, drain_pending, prepare, process_record_event
from runtime.common import RuntimeFailure
from runtime.events import publish
from storage.models import Agent, Domain, ServiceDefinition, Template
from template import services


def event(number=1, value=8, **overrides):
    return {"type": "anomaly.recorded", "domainName": "leaves", "tenant": "company-1", "entityType": "leave-request",
            "entityId": f"leave-{number}", "version": 1, "occurredAt": f"2026-09-{number:02d}T00:00:00Z", "finalized": True,
            "measurements": [{"name": "hours", "value": value, "unit": "hours", "dimensions": {"employeeId": "E1", "leaveType": "vacation"}}],
            **overrides}


class RollingFeatureTests(SimpleTestCase):
    def test_incremental_corrections_eviction_and_event_time(self):
        features = RollingFeatures()
        for number in range(WINDOW_SIZE + 10):
            features.put(str(number), f"{number:05d}", number)
        values = list(range(10, WINDOW_SIZE + 10))
        self.assertAlmostEqual(features.summary()["mean"], mean(values))
        self.assertAlmostEqual(features.summary()["variance"], variance(values))
        features.put("20", "00020", 300)
        values[10] = 300
        self.assertEqual(features.summary()["count"], WINDOW_SIZE)
        self.assertAlmostEqual(features.summary()["variance"], variance(values))
        self.assertEqual(features.before("00020")["max"], 19)
        self.assertEqual(features.before("00021", exclude="20")["max"], 19)
        self.assertEqual(features.summary()["max"], 300)

    def test_contract_rejects_ambiguous_data_and_normalizes_time(self):
        self.assertEqual(validate_record_event(event())["occurredAt"], "2026-09-01T00:00:00.000000+00:00")
        for change in ({"version": True}, {"version": 1.5}, {"version": 2**53}, {"occurredAt": "2026-09-01"}, {"finalized": "yes"}, {"unexpected": True}):
            with self.subTest(change=change), self.assertRaises(RuntimeFailure):
                validate_record_event(event(**change))
        for value in (True, float("nan"), float("inf"), "8"):
            with self.subTest(value=value), self.assertRaises(RuntimeFailure):
                validate_record_event(event(value=value))
        duplicated = event()
        duplicated["measurements"] *= 2
        with self.assertRaises(RuntimeFailure):
            validate_record_event(duplicated)


class RecordStreamTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        services.sync_templates()
        Domain.objects.create(name="leaves", label="Leaves", domain="Leaves")
        Domain.objects.create(name="insurance", label="Insurance", domain="Insurance")

    def setUp(self):
        # A non-payroll template ID proves runtime selection follows components.
        self.saved = Agent.objects.create(domain_id="leaves", name="Leave anomalies", template_id="leave-anomalies", template_version=1,
            config={"domain": "Leaves", "model": "poc-demo", "anomaly": {"profile": "records"}, "capabilities": {"alerts": {"enabled": True}}},
            model_config=services.model_data(services.ModelConfiguration.objects.get(pk="poc-demo")))
        ServiceDefinition.objects.get_or_create(id="test-leave-records", defaults={"name": "Leave records", "domain": "Leaves", "base_url_env": "LEAVES_API", "method": "GET", "path": "/records"})
        self.saved.config["service"] = "test-leave-records"
        self.saved.save()
        grant_read(self.saved)
        self.headers = {"x-session-owner": "a" * 64}

    def ingest(self, payload):
        result = accept(payload)
        process_record_event(result["eventId"])
        return AnomalyEvent.objects.get(pk=result["eventId"])

    def seed(self):
        for number, value in enumerate([7, 8, 9], 1):
            self.ingest(event(number, value))

    def test_baseline_is_pre_event_and_only_finalized_records_contribute(self):
        self.seed()
        with patch("model.model.Model.generate") as model, patch("runtime.payroll.load_context", side_effect=AssertionError("No payroll reads")):
            archived = self.ingest(event(4, 80, finalized=False))
        model.assert_not_called()
        self.assertEqual(archived.context["baselines"][0]["mean"], 8)
        self.assertEqual(archived.context["baselines"][0]["count"], 3)
        state = AnomalyFeatureState.objects.get(pk=feature_key(archived.payload, archived.payload["measurements"][0])).state
        self.assertEqual(state["count"], 3)
        case = AnomalyCase.objects.get(payrun_id="leave-4")
        self.assertEqual(case.decision, "REVIEW")
        self.assertEqual(case.snapshot["detection"]["severity"], "critical")
        self.assertEqual(case.review_status, "pending")

    def test_replay_conflicts_and_corrections_do_not_double_count(self):
        original = self.ingest(event())
        self.assertTrue(accept(event())["duplicate"])
        self.assertFalse(process_record_event(original.id))
        with self.assertRaises(RuntimeFailure) as error:
            accept(event(value=99))
        self.assertEqual(error.exception.status, 409)
        corrected = self.ingest(event(value=10, version=2))
        state = AnomalyFeatureState.objects.get(pk=feature_key(corrected.payload, corrected.payload["measurements"][0])).state
        self.assertEqual((state["count"], state["mean"]), (1, 10))
        self.assertEqual(corrected.context["baselines"][0]["count"], 0)
        self.ingest(event(value=10, version=3, finalized=False))
        self.assertEqual(AnomalyFeatureState.objects.get().state["count"], 0)

    def test_out_of_order_events_never_use_future_or_same_time_values(self):
        self.ingest(event(8, 1000))
        self.ingest(event(2, 7))
        self.ingest(event(3, 8))
        observed = self.ingest(event(4, 9))
        self.assertEqual(observed.context["baselines"][0]["count"], 2)
        self.assertEqual(observed.context["baselines"][0]["mean"], 7.5)
        same_time = self.ingest(event(9, 10, occurredAt="2026-09-04T00:00:00Z"))
        self.assertEqual(same_time.context["baselines"][0]["count"], 2)

    def test_superseded_version_is_archived_without_reverting_state(self):
        pending = accept(event())
        self.ingest(event(value=10, version=2))
        process_record_event(pending["eventId"])
        self.assertEqual(AnomalyEvent.objects.get(pk=pending["eventId"]).status, "superseded")
        self.assertEqual(AnomalyRecord.objects.get().version, 2)
        self.assertEqual(AnomalyFeatureState.objects.get().state["mean"], 10)

    def test_domains_tenants_units_and_dimensions_do_not_share_baselines(self):
        self.seed()
        variants = [event(4, domainName="insurance"), event(4, tenant="company-2")]
        different_unit, different_group = event(4), event(4)
        different_unit["measurements"][0]["unit"] = "days"
        different_group["measurements"][0]["dimensions"]["employeeId"] = "E2"
        variants.extend([different_unit, different_group | {"entityId": "other"}])
        for payload in variants:
            with self.subTest(payload=payload):
                archived = self.ingest(payload)
                self.assertEqual(archived.context["baselines"][0]["count"], 0)

    def test_failed_delivery_retry_reuses_prior_features_and_case(self):
        self.seed()
        accepted = accept(event(4, 80))
        with self.assertRaises(RuntimeError):
            process_record_event(accepted["eventId"], broadcast=Mock(side_effect=RuntimeError("transport down")))
        archived = AnomalyEvent.objects.get(pk=accepted["eventId"])
        baseline = deepcopy(archived.context)
        AnomalyEvent.objects.filter(pk=archived.id).update(lease_until=timezone.now() - timedelta(seconds=1))
        self.assertTrue(process_record_event(archived.id))
        archived.refresh_from_db()
        self.assertEqual(archived.context, baseline)
        self.assertEqual(AnomalyCase.objects.filter(payrun_id="leave-4").count(), 1)
        self.assertEqual(AnomalyFeatureState.objects.get().state["count"], 4)

    def test_archive_survives_unavailable_broker_and_worker_quarantines_poison_event(self):
        with patch.dict(os.environ, PAYROLL_EVENTS_TOKEN="shared"), patch("runtime.events.redis_client", side_effect=AssertionError("No broker needed")):
            with self.assertRaises(RuntimeFailure):
                publish(event(), {})
            result = publish(event(), {"x-payroll-events-token": "shared"})
        with patch("agents.anomaly_detection.streaming.prepare", side_effect=RuntimeError("bad adapter")):
            for attempt in range(5):
                AnomalyEvent.objects.filter(pk=result["eventId"]).update(lease_until=None)
                drain_pending()
        archived = AnomalyEvent.objects.get(pk=result["eventId"])
        self.assertEqual((archived.status, archived.attempts), ("failed", 5))
        self.assertEqual(drain_pending(), 0)

    def test_factory_listing_and_human_review_reuse_generic_pipeline(self):
        self.seed()
        self.ingest(event(4, 80, finalized=False))
        runtime = AgentFactory().load("leaves", str(self.saved.id))
        self.assertIsInstance(runtime, AnomalyDetectionAgent)
        case = AnomalyCase.objects.get(payrun_id="leave-4")
        sources = runtime.components.tools.collect(case.snapshot["context"], case.snapshot["detection"])
        runtime.model = Mock(metrics=None, generate=Mock(return_value=json.dumps({"summary": "The requested hours exceed the observed baseline.",
            "sourceIds": [sources[0]["id"]], "findings": [{"findingId": item["id"], "explanation": "Above the historical range.", "reviewAction": "Check the leave authorization."}
                                                           for item in case.snapshot["detection"]["findings"]]})))
        with patch.dict(os.environ, STUDIO_ADMIN_KEY="", ADMIN_FEATURES="all"):
            listed = list_anomalies({"domainName": "leaves", "entityId": "leave-4", "entityType": "leave-request", "tenant": "company-1"}, self.headers)
            self.assertEqual(listed["items"][0]["id"], case.id)
            self.assertEqual(list_anomalies({"domainName": "leaves", "entityId": "leave-4", "entityType": "leave-request", "tenant": "company-2"}, self.headers)["items"], [])
        body = {"action": "REVIEW", "anomalyId": case.id, "expectedVersion": 1}
        result = runtime.review(body, self.headers)
        self.assertEqual(result["reviewStatus"], "completed")
        runtime.review(body, self.headers)
        runtime.model.generate.assert_called_once()
        self.ingest(event(4, 81, version=2, finalized=False))
        with self.assertRaises(RuntimeFailure):
            runtime.review(body, self.headers)

    def test_untrusted_model_output_never_replaces_calculated_evidence(self):
        self.seed()
        archived = self.ingest(event(4, 80, finalized=False))
        detection = RecordDetector().detect(archived.context)
        model = Mock(generate=Mock(return_value='{"summary":"Approved","sourceIds":["invented"],"findings":[]}'))
        result = RecordInvestigator().investigate({}, archived.context, detection, model=model, tools=RecordEvidenceTools())
        self.assertEqual(result["modelStatus"], "invalid_response")
        self.assertEqual(result["summary"], detection["summary"])
        self.assertEqual(result["analysis"]["findings"], detection["findings"])

    def test_rules_and_optional_model_receive_features_and_fail_independently(self):
        prepared = prepare(accept(event(value=100))["eventId"])
        scorer = Mock(score=Mock(side_effect=RuntimeError("unavailable")))
        result = RecordDetector(rules=[RangeRule("hours", maximum=40)], decision_model=scorer).detect(prepared)
        self.assertEqual(result["decision"], "REVIEW")
        self.assertEqual(result["analysis"]["decisionModelStatus"], "unavailable")
        self.assertEqual(set(scorer.score.call_args.args[0]), {"record", "baselines"})
        self.assertEqual(result["findings"][0]["evidence"]["maximum"], 40)

    def test_leaves_example_creates_a_saved_agent_through_the_normal_factory(self):
        examples = Path(__file__).resolve().parents[1] / "examples" / "anomaly"
        service = json.loads((examples / "leaves-service.json").read_text())
        ServiceDefinition.objects.create(**service)
        template = json.loads((examples / "leaves-template.json").read_text())
        config = template["config"]
        Template.objects.create(id=template["id"], name=template["name"], version=1, description=template["description"],
                                config=config, default_model_id=config["model"], service_id=config["service"])
        saved = AgentFactory().create("leaves", template["id"], "Leave reviewer", {})
        self.assertEqual(saved.config["anomaly"]["enricher"], "rolling")
        self.assertIsInstance(AgentFactory().load("leaves", str(saved.id)), AnomalyDetectionAgent)

    def test_review_cannot_use_a_stale_record_while_a_revision_is_pending(self):
        self.seed()
        archived = self.ingest(event(4, 80, finalized=False))
        runtime = AgentFactory().load("leaves", str(self.saved.id))
        case = AnomalyCase.objects.get(payrun_id="leave-4")
        accept(event(4, 81, version=2, finalized=False))
        with patch.object(runtime.model, "generate") as model, self.assertRaises(RuntimeFailure) as failure:
            runtime.review({"action": "REVIEW", "anomalyId": case.id, "expectedVersion": 1}, self.headers)
        self.assertEqual(failure.exception.status, 409)
        model.assert_not_called()

    def test_payroll_measurements_use_current_only_and_preserve_units_and_missing_values(self):
        from agents.anomaly_detection.domains.payroll_records import payrun_events
        from runtime.events import process
        from tests.test_runtime import fixture
        run = fixture()["current"]
        run["lines"][0]["earnings"]["bonus"] = None
        monitor = {"id": str(self.saved.id), "template_id": "anomaly-detection", "config": {
            "domain": "Payroll", "anomaly": {"profile": "records"}, "capabilities": {"alerts": {"enabled": True}}}}
        with patch("runtime.events.agent_access.can_read", return_value=True), patch("runtime.events.services.list_domains", return_value=[{"name": "leaves"}]), \
                patch("runtime.events.services.get_service_agent_registry", return_value=[monitor]), \
                patch("runtime.events.load_context", side_effect=AssertionError("No history reads")), \
                patch("runtime.payroll.load_current", return_value=run) as load:
            process({"payrunId": run["id"]})
        load.assert_called_once()
        payload = payrun_events(run, "leaves")[0]
        self.assertEqual(len(payload["measurements"]), 30)
        self.assertEqual(next(item for item in payload["measurements"] if item["name"] == "hours.regular")["unit"], "hours")
        self.assertIsNone(next(item for item in payload["measurements"] if item["name"] == "earnings.bonus")["value"])
        self.assertTrue(AnomalyEvent.objects.exists())
        self.assertFalse(AnomalyCase.objects.exists())

    def test_backfill_is_resumable_and_does_not_create_review_cases(self):
        from django.core.management import call_command
        from io import StringIO
        from tests.test_runtime import fixture
        run = deepcopy(fixture()["current"])
        run["status"] = "COMPLETED"
        response = {"data": {"payruns": [run]}}
        with patch("storage.management.commands.ingest_anomaly_payroll_history.request_json", return_value=response), \
                patch.dict(os.environ, TRINET_API_URL="http://example.invalid/graphql"):
            call_command("ingest_anomaly_payroll_history", domain="leaves", dry_run=True, stdout=StringIO())
            self.assertFalse(AnomalyEvent.objects.exists())
            call_command("ingest_anomaly_payroll_history", domain="leaves", stdout=StringIO())
            before = list(AnomalyFeatureState.objects.order_by("id").values_list("state", flat=True))
            call_command("ingest_anomaly_payroll_history", domain="leaves", stdout=StringIO())
        self.assertEqual(before, list(AnomalyFeatureState.objects.order_by("id").values_list("state", flat=True)))
        self.assertFalse(AnomalyCase.objects.exists())
        self.assertEqual(set(AnomalyEvent.objects.values_list("status", flat=True)), {"completed"})

    def test_custom_domain_rules_reuse_the_record_worker(self):
        from dataclasses import replace
        from agents.anomaly_detection.components import PROFILES
        profile = replace(PROFILES["records"], category="Leaves", detectors={"leave-policy": lambda: RecordDetector(rules=[RangeRule("hours", maximum=40)])},
                          defaults={**PROFILES["records"].defaults, "detector": "leave-policy"})
        self.saved.config["anomaly"] = {"profile": "leaves-records"}
        self.saved.save(update_fields=["config"])
        with patch.dict(PROFILES, {"leaves-records": profile}):
            self.ingest(event(value=80, finalized=False))
        case = AnomalyCase.objects.get()
        self.assertEqual(case.decision, "REVIEW")
        self.assertEqual(case.snapshot["detection"]["findings"][0]["code"], "range_rule")

    def test_active_leases_are_exclusive_and_expired_final_attempts_are_quarantined(self):
        result = accept(event())
        AnomalyEvent.objects.filter(pk=result["eventId"]).update(status="processing", attempts=1, lease_until=timezone.now() + timedelta(minutes=1))
        self.assertFalse(process_record_event(result["eventId"]))
        AnomalyEvent.objects.filter(pk=result["eventId"]).update(attempts=5, lease_until=timezone.now() - timedelta(seconds=1))
        drain_pending()
        self.assertEqual(AnomalyEvent.objects.get(pk=result["eventId"]).status, "failed")

    def test_projection_failure_rolls_back_raw_record_pointer_and_all_feature_updates(self):
        result = accept(event())
        with patch("agents.anomaly_detection.streaming.AnomalyFeatureState.objects.bulk_update", side_effect=RuntimeError("storage failure")):
            with self.assertRaises(RuntimeError):
                prepare(result["eventId"])
        self.assertIsNone(AnomalyEvent.objects.get(pk=result["eventId"]).context)
        self.assertFalse(AnomalyRecord.objects.exists())
        self.assertFalse(AnomalyFeatureState.objects.exists())
