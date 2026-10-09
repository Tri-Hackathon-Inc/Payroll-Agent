"""Durable ingestion, incremental features, and retryable domain-neutral checks.

The event archive doubles as an inbox so a broker outage cannot lose an accepted
event. Workers may be deployed separately; short database leases claim work.
"""
from runtime import agent_access
from copy import deepcopy
from datetime import timedelta

from django.db import transaction
from django.db.models import F, Q
from django.utils import timezone

from runtime.common import RuntimeFailure, digest
from template import services
from .features.rolling import RollingFeatures
from .records import feature_key, source_key, validate_record_event
from .stream_models import AnomalyEvent, AnomalyFeatureState, AnomalyRecord


MAX_ATTEMPTS = 5
LEASE_SECONDS = 120


def accept(body, *, backfill=False):
    event = validate_record_event(body)
    services.get_domain(event["domainName"])
    source = source_key(event)
    identity = digest([source, event["version"]])
    archived, created = AnomalyEvent.objects.get_or_create(id=identity, defaults={
        "domain_id": event["domainName"], "source_key": source, "version": event["version"], "payload": event,
        "status": "backfill" if backfill else "pending",
    })
    if archived.payload != event:
        raise RuntimeFailure("This source version was already submitted with different data. Increment version for corrections.", 409)
    return {"accepted": True, "eventId": identity, "duplicate": not created, "status": archived.status}


@transaction.atomic
def prepare(identity):
    event = AnomalyEvent.objects.select_for_update().get(pk=identity)
    AnomalyRecord.objects.get_or_create(id=event.source_key)
    source = AnomalyRecord.objects.select_for_update().get(pk=event.source_key)
    if source.version > event.version:
        event.status = "superseded"
        event.save(update_fields=["status"])
        return None
    if event.context is not None:
        return deepcopy(event.context)
    payload = event.payload
    keys = [feature_key(payload, item) for item in payload["measurements"]]
    # Lock in deterministic order, including keys removed by a source correction.
    affected = sorted(set(keys) | set(source.feature_keys))
    AnomalyFeatureState.objects.bulk_create([AnomalyFeatureState(id=key) for key in affected], ignore_conflicts=True)
    buckets = {bucket.id: bucket for bucket in AnomalyFeatureState.objects.select_for_update().filter(id__in=affected).order_by("id")}
    states = {key: RollingFeatures(bucket.state) for key, bucket in buckets.items()}
    baselines = [states[key].before(payload["occurredAt"], exclude=event.source_key) for key in keys]
    context = {"record": payload, "baselines": baselines, "eventId": identity}
    for state in states.values():
        state.remove(event.source_key)
    contributed = []
    if payload["finalized"]:
        for key, measurement in zip(keys, payload["measurements"], strict=True):
            if measurement["value"] is not None:
                states[key].put(event.source_key, payload["occurredAt"], measurement["value"])
                contributed.append(key)
    for key, bucket in buckets.items():
        bucket.state = states[key].state
        bucket.updated_at = timezone.now()
    AnomalyFeatureState.objects.bulk_update(list(buckets.values()), ["state", "updated_at"])
    event.context = context
    event.save(update_fields=["context"])
    source.version, source.event, source.feature_keys = event.version, event, contributed
    source.save(update_fields=["version", "event", "feature_keys"])
    return deepcopy(context)


def process_record_event(identity, broadcast=None):
    now = timezone.now()
    ready = Q(status="pending", lease_until__isnull=True) | Q(status__in=["pending", "processing"], lease_until__lte=now)
    claimed = AnomalyEvent.objects.filter(ready, pk=identity, attempts__lt=MAX_ATTEMPTS).update(
        status="processing", lease_until=now + timedelta(seconds=LEASE_SECONDS), attempts=F("attempts") + 1)
    if not claimed:
        return False
    # This token prevents a slow worker from completing another worker's lease.
    lease = now + timedelta(seconds=LEASE_SECONDS)
    try:
        context = prepare(identity)
        if context is None:
            return True
        from .agent import AnomalyDetectionAgent
        from .components import PROFILES, anomaly_settings, is_anomaly_agent
        event = context["record"]
        definitions = services.get_service_agent_registry("", event["domainName"])
        for definition in definitions:
            if not agent_access.can_read(definition):
                continue
            if not is_anomaly_agent(definition) or not definition["config"].get("capabilities", {}).get("alerts", {}).get("enabled"):
                continue
            settings = anomaly_settings(definition["config"])
            if PROFILES[settings["profile"]].event_type != event["type"]:
                continue
            runtime = AnomalyDetectionAgent({**definition, "domain_name": event["domainName"]})
            result = runtime.on_change(event, context)
            if broadcast is not None:
                broadcast(result)
        AnomalyEvent.objects.filter(pk=identity, lease_until=lease, status="processing").update(status="completed", lease_until=None)
        return True
    except Exception:
        archived = AnomalyEvent.objects.get(pk=identity)
        AnomalyEvent.objects.filter(pk=identity, lease_until=lease, status="processing").update(
            status="failed" if archived.attempts >= MAX_ATTEMPTS else "pending",
            lease_until=timezone.now() + timedelta(seconds=min(60, 2 ** archived.attempts)),
        )
        raise


def drain_pending(limit=10, broadcast=None):
    now = timezone.now()
    # A worker that died on its last attempt leaves an expired lease; quarantine
    # it too, rather than leaving an unclaimable record permanently processing.
    AnomalyEvent.objects.filter(status="processing", lease_until__lte=now, attempts__gte=MAX_ATTEMPTS).update(status="failed")
    ready = Q(status="pending", lease_until__isnull=True) | Q(status__in=["pending", "processing"], lease_until__lte=now)
    identities = list(AnomalyEvent.objects.filter(ready, attempts__lt=MAX_ATTEMPTS).order_by("created_at").values_list("id", flat=True)[:limit])
    completed = 0
    for identity in identities:
        try:
            completed += process_record_event(identity, broadcast=broadcast)
        except Exception:
            # Retry metadata is recorded above. One poison event must not stop
            # other entities or leak source payloads into logs.
            continue
    return completed
