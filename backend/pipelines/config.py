"""Validated, serializable agent pipeline settings; old saved agents keep their defaults."""
import math
import os
from copy import deepcopy

DEFAULT_PIPELINES = {
    "query": {"enabled": True, "questionMatching": True, "includeSharedQuestions": True,
              "candidateLimit": 3, "confirmationTtlSeconds": 600, "historyLimit": 100, "retrievalLimit": 6},
    "response": {"enabled": True, "includeDetails": True},
}


def pipeline_settings(config):
    result = deepcopy(DEFAULT_PIPELINES)
    # Preserve deployment defaults for existing agents; new agents persist the resolved values.
    result["query"]["historyLimit"] = max(1, min(int(os.getenv("RAG_HISTORY_LIMIT", "100")), 500))
    result["query"]["retrievalLimit"] = max(1, min(int(os.getenv("RAG_TOP_K", "6")), 20))
    supplied = config.get("pipelines", {})
    if not isinstance(supplied, dict) or set(supplied) - set(result):
        raise ValueError("pipelines supports query and response settings only.")
    for stage, settings in supplied.items():
        if not isinstance(settings, dict) or set(settings) - set(result[stage]):
            raise ValueError(f"Unknown {stage} pipeline settings.")
        result[stage].update(settings)
    for stage, keys in (("query", ("enabled", "questionMatching", "includeSharedQuestions")), ("response", ("enabled", "includeDetails"))):
        for key in keys:
            if type(result[stage][key]) is not bool:
                raise ValueError(f"pipelines.{stage}.{key} must be boolean.")
    for key, lower, upper in (("candidateLimit", 1, 5), ("confirmationTtlSeconds", 60, 3600), ("historyLimit", 1, 500), ("retrievalLimit", 1, 20)):
        value = result["query"][key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or int(value) != value or not lower <= value <= upper:
            raise ValueError(f"pipelines.query.{key} must be an integer from {lower} to {upper}.")
        result["query"][key] = int(value)
    return result


def validate_model_parameters(parameters):
    if not isinstance(parameters, dict) or set(parameters) - {"temperature", "top_p", "max_tokens"}:
        raise ValueError("model_parameters supports temperature, top_p and max_tokens only.")
    for key, value in parameters.items():
        limit = {"temperature": (0, 2), "top_p": (0, 1), "max_tokens": (1, 32768)}[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not limit[0] <= value <= limit[1] or key == "max_tokens" and value != int(value):
            raise ValueError(f"Invalid model_parameters.{key}.")
