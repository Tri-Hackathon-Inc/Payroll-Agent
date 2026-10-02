import hashlib
import logging
import re
import time

from agents import metrics
from template import services
from agent_factory.factory import AgentFactory
from runtime import access
from runtime.common import RuntimeFailure
from runtime.incidents import create_report, raise_incidents
from agents.anomaly_detection.rules import detect_signals
from agents.anomaly_detection.components import is_anomaly_agent
from runtime.payroll import load_context, preprocess
from runtime.sessions import with_conversation

logger = logging.getLogger(__name__)


def record(domain_name, agent, question, invocation, answer, elapsed, source="", context=None):
    hashed = lambda text: hashlib.sha256(str(text).encode()).hexdigest()[:32] if text else ""
    model_metrics = answer.get("metrics") or {}
    findings = detect_signals(context["current"], context["history"]) if context else []
    alert = answer.get("incidentAlert") or {}
    incident = (alert.get("raised") or {}).get("incident") or answer.get("incident") or {}
    analysis = answer.get("analysis") or {}
    data = {"question": question[:500], "answeredBy": answer.get("answeredBy", "model"), "source": source[:60],
            "sessionId": hashed((answer.get("session") or {}).get("id")), "payrunId": invocation.get("payrunId") or "", "modelId": agent["config"].get("model", ""),
            "latencyMs": round(elapsed), "modelLatencyMs": model_metrics.get("latencyMs"), "promptTokens": model_metrics.get("promptTokens"), "completionTokens": model_metrics.get("completionTokens"),
            "answerHash": hashed(re.sub(r"\s+", " ", answer.get("reply", "").lower()).strip()), "incidentId": incident.get("id", ""),
            "findings": {severity: sum(item["severity"] == severity for item in findings) for severity in ("critical", "warning", "info")} if context else None,
            "amountAtRisk": sum(item.get("amountAtRisk") or 0 for item in findings), "suggestedCount": len(alert.get("suggested", [])),
            "intent": (answer.get("retrieval") or {}).get("intent", {}).get("intent", ""),
            "checkStatus": "passed" if analysis.get("modelStatus") == "completed" else "flagged" if analysis.get("modelStatus") == "invalid_response" else ""}
    try:
        return metrics.record_interaction(domain_name, agent["id"], data)
    except Exception:
        logger.warning("Interaction metrics could not be recorded.")
        return None


def execute(payload, headers):
    started = time.monotonic()
    channel = payload.get("channel", "studio")
    if channel not in ("studio", "payroll"):
        raise RuntimeFailure("Invalid chat channel.", 400)
    if channel == "studio":
        access.require(headers, "testAgents")
    domain, agent_id = payload.get("domainName"), payload.get("agentId")
    if not isinstance(domain, str) or not domain.strip() or not isinstance(agent_id, str) or not agent_id.strip():
        raise RuntimeFailure("An agent and domain are required.", 400)
    runtime_agent = AgentFactory().load(domain, agent_id)
    agent = runtime_agent.definition
    question = payload.get("question", payload.get("message"))
    if not isinstance(question, str) or not question.strip() or len(question) > 10000:
        raise RuntimeFailure("A question of at most 10,000 characters is required.", 400)
    invocation = payload.get("context") or {}
    if not isinstance(invocation, dict):
        raise RuntimeFailure("Conversation context must be an object.", 400)
    loaded = {}

    def load(options):
        payrun_id = options.get("payrunId", options.get("entityId"))
        if payrun_id not in loaded:
            if is_anomaly_agent(agent):
                loaded[payrun_id] = runtime_agent.components.domain.load(options)
            else:
                loaded[payrun_id] = load_context(options, history_limit=runtime_agent.settings["query"]["historyLimit"])
        return loaded[payrun_id]

    if invocation.get("task") == "incident-report":
        if agent.get("template_id") != "incident-report":
            raise RuntimeFailure("Select the Incident Report agent for this handoff.", 400)
        answer = create_report(agent, domain, invocation)
    else:
        effective = {}

        def run(conversation):
            effective.update(conversation["context"])
            return runtime_agent.respond(question.strip(), effective, conversation, payload.get("confirmation"), load=load)

        owner = headers.get("x-session-owner")
        if not owner or not re.fullmatch(r"[a-f0-9]{64}", owner):
            raise RuntimeFailure("A browser session owner is required.", 400)
        answer = with_conversation({**payload, "question": question, "context": invocation, "scope": {"domainName": domain, "agentId": agent_id, "channel": channel, "owner": owner}}, run)
        invocation = effective
        if not is_anomaly_agent(agent) and answer.get("status") != "confirmation_required" and answer.get("answeredBy") != "clarification" and effective.get("payrunId") and agent["config"].get("capabilities", {}).get("alerts", {}).get("enabled"):
            context = load(effective)
            try:
                answer["incidentAlert"] = raise_incidents(agent, services.get_service_agent_registry("", domain), domain, context, preprocess(context["current"], context["history"]))
            except Exception:
                answer["incidentAlert"] = {"raised": None, "suggested": [], "alreadyRaised": 0, "note": "Incident processing is unavailable; calculated findings remain available."}
    if answer.get("status") != "confirmation_required":
        metrics_context = loaded.get(invocation.get("payrunId"))
        if is_anomaly_agent(agent) and runtime_agent.components.settings["profile"] != "payroll":
            metrics_context = None
        answer["interactionId"] = record(domain, agent, question, invocation, answer, (time.monotonic()-started)*1000, str(payload.get("source") or channel), metrics_context)
    return {"agent": {"id": agent_id, "name": agent["name"]}, "agent_id": agent_id, "model_id": agent["model_config"].get("model_id", ""), "output": answer["reply"], "demo": answer.get("demo", False), **answer}
