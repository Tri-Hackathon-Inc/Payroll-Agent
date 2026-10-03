"""Runtime agent composed from independently replaceable model and pipeline contracts."""
from copy import deepcopy
from agents.interface import AgentInterface
from model.model import Model
from pipelines.config import pipeline_settings
from runtime.common import RuntimeFailure, digest
from runtime.payroll import load_context
from pipelines.payroll import PayrollQueryPipeline, PayrollResponsePipeline, answer_payroll
from agents.question.logic import question_flow


class ConfiguredAgent(AgentInterface):
    def __init__(self, definition, *, model=None, query_pipeline=None, response_pipeline=None, runtime_factory=None):
        self.definition = deepcopy(definition)
        self.settings = pipeline_settings(definition["config"])
        self.model = model if model is not None else Model(definition["model_config"], runtime_factory)
        self.query_pipeline = query_pipeline if query_pipeline is not None else PayrollQueryPipeline()
        self.response_pipeline = response_pipeline if response_pipeline is not None else PayrollResponsePipeline(self.settings["response"])

    def respond(self, question, context, conversation, confirmation=None, *, load=load_context):
        if context.get("payrunId") and self.settings["query"]["enabled"]:
            def answer(mapped):
                return answer_payroll(self.definition, self.definition["domain_name"], context, conversation, mapped,
                                      load=load, model=self.model, query_pipeline=self.query_pipeline, response_pipeline=self.response_pipeline)
            contextual_chat = self.definition.get("template_id") == "general-query" and context.get("page") == "payrun"
            if contextual_chat:
                return question_flow(self.definition, self.definition["domain_name"], question, None,
                                     {**conversation, "context": context}, answer, automatic=True)
            if self.settings["query"]["questionMatching"] and not contextual_chat:
                return question_flow(self.definition, self.definition["domain_name"], question, confirmation, conversation, answer)
            if confirmation is not None:
                raise RuntimeFailure("Question matching is disabled for this agent. Submit a new query.", 409)
            result = answer({"id": digest(question), "text": question, "originalQuery": question, "confirmed": False})
            focus = result.pop("focus", None)
            return {"answer": result, "focus": focus}
        if confirmation is not None:
            raise RuntimeFailure("No query-selection pipeline is active for this request.", 409)
        messages = [{"role": "system", "content": self.definition["config"]["instructions"]},
                    *conversation.get("history", []), {"role": "user", "content": question.strip()}]
        text = self.model.generate(messages)
        if self.settings["response"]["enabled"]:
            text = text.strip()
        config = self.definition["model_config"]
        return {"answer": {"reply": text, "answeredBy": "model", "demo": config.get("provider") == "demo",
                           "model": {"id": config.get("id"), "modelId": config.get("model_id"), "name": config.get("name")}, "metrics": getattr(self.model, "metrics", None)}}
