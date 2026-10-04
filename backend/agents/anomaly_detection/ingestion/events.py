"""Transport-neutral event entry point for Kafka, Redis or trusted backend consumers."""
from runtime.common import RuntimeFailure, numeric
from ..interface import EntityReference


def ingest(event, *, agent=None):
    if not isinstance(event, dict) or any(not isinstance(event.get(key), str) or not event[key] or len(event[key]) > 100
                                          for key in ("domainName", "agentId", "entityType", "entityId")):
        raise RuntimeFailure("Anomaly events require domainName, agentId, entityType and entityId.", 400)
    version = event.get("version")
    if not numeric(version) or version <= 0 or int(version) != version:
        raise RuntimeFailure("Anomaly events require a positive integer source version.", 400)
    if agent is None:
        from agent_factory.factory import AgentFactory
        agent = AgentFactory().load(event["domainName"], event["agentId"])
    from ..agent import AnomalyDetectionAgent
    if (not isinstance(agent, AnomalyDetectionAgent) or agent.definition["domain_name"] != event["domainName"]
            or str(agent.definition["id"]) != event["agentId"]):
        raise RuntimeFailure("Event does not match the selected anomaly agent.", 400)
    requested = EntityReference(event["entityType"], event["entityId"], int(version), "")
    domain = agent.components.domain
    context = domain.load(domain.invocation(requested))
    current = domain.reference(context)
    if current.kind != requested.kind or current.identity != requested.identity or current.version < requested.version:
        raise RuntimeFailure("Source data does not match this event.", 409)
    return agent.on_change(event, context)


def deliver(event, acknowledge, *, handler=ingest):
    """Commit a consumer offset only after successful durable handling.

    The caller owns deserialization, retry/backoff, dead letters and partitions.
    Kafka clients can supply their manual offset commit as acknowledge.
    Replayed events check the latest source version; case IDs deduplicate them.
    """
    result = handler(event)
    acknowledge()
    return result
