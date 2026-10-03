"""Read-only attached-agent connectivity checks. No inference or business API reads."""
import json
import os
from urllib.parse import urlsplit
from urllib.request import Request, build_opener

from agent_factory.factory import AgentFactory
from model.runtime import NoRedirects
from runtime import access
from runtime.common import now_iso, request_json
from storage.models import Agent, ServiceDefinition
from template import services


def probe_service(service):
    if not service or not service.enabled:
        return False, "The primary service is missing or disabled."
    # Payroll's source is GraphQL. __typename verifies connectivity without
    # fetching employee data or publishing a monitored payrun-read event.
    if service.id in ("payrun", "payrun-history", "employee-details"):
        response = request_json(os.getenv("TRINET_API_URL", "http://trinet-api:4001/graphql"),
                                {"query": "query AgentHealth { __typename }"}, timeout=3)
        ok = isinstance(response, dict) and not response.get("errors") and bool((response.get("data") or {}).get("__typename"))
        return ok, "Primary service responded." if ok else "The primary service did not return a healthy response."
    # Other domains use a deployment-owned health URL, never a browser-supplied URL.
    override = service.base_url_env.removesuffix("_BASE_URL") + "_HEALTH_URL"
    base = os.getenv(service.base_url_env, "").rstrip("/")
    url = os.getenv(override) or (base + "/health" if base else "")
    if not url or urlsplit(url).scheme not in ("http", "https"):
        return False, "The primary service health endpoint is not configured."
    with build_opener(NoRedirects()).open(Request(url, method="GET"), timeout=3) as response:
        content = response.read(65537)
        if len(content) > 65536:
            return False, "The service health response was invalid."
        if "json" in response.headers.get("Content-Type", ""):
            data = json.loads(content)
            if not isinstance(data, dict) or data.get("ok") is False or data.get("status") in ("down", "unhealthy", "error"):
                return False, "The primary service reported an unhealthy state."
        return 200 <= response.status < 300, "Primary service responded."


def agent_health(body, headers):
    access.require(headers, "testAgents", "manageAgents", "createAgents", "agentTools")
    domain = services.get_domain(body.get("domainName"))
    agents = Agent.objects.filter(domain=domain)
    if body.get("agentId"):
        agents = agents.filter(pk=body["agentId"])
    result, probes = [], {}
    for saved in agents:
        service_id = saved.config.get("service")
        if not service_id:
            continue
        live, reason = False, "The agent configuration could not be loaded."
        try:
            runtime = AgentFactory().load(domain.name, str(saved.pk))
            model = runtime.definition.get("model_config", {})
            decision = getattr(getattr(runtime, "components", None), "detector", None)
            decision = getattr(decision, "decision_model", None)
            readiness = decision.readiness() if hasattr(decision, "readiness") else {"status": "ready"}
            if not model.get("enabled", True):
                reason = "The selected model is disabled."
            elif model.get("credential_env") and not os.getenv(model["credential_env"]):
                reason = "The selected model credential is not configured."
            elif readiness["status"] != "ready":
                reason = readiness["reason"]
            else:
                if service_id not in probes:
                    try:
                        probes[service_id] = probe_service(ServiceDefinition.objects.filter(pk=service_id, domain=domain.domain).first())
                    except Exception:
                        probes[service_id] = (False, "The primary service is unreachable or its health check failed.")
                live, reason = probes[service_id]
        except Exception:
            pass  # Never expose provider endpoints, credentials or exception traces.
        result.append({"agentId": str(saved.pk), "agentName": saved.name, "serviceId": service_id,
                       "status": "live" if live else "not_connected", "reason": reason, "checkedAt": now_iso()})
    return {"items": result, "scope": "Agent configuration and primary service connectivity; inference is not tested."}
