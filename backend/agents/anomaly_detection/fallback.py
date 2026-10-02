"""Bounded Hugging Face backup for user-authorized investigations only."""
import os

from model.model import Model
from model.runtime import ModelConfigurationError, ModelExecutionError, ModelTimeout


class InvestigationModel:
    def __init__(self, primary, *, primary_name=None, primary_provider=None, fallback_factory=Model):
        self.primary = primary
        self.active = primary
        self.fallback_factory = fallback_factory
        self.calls = 0
        self.metrics = None
        self.route = {"fallback": False, "model": primary_name, "provider": primary_provider}

    def use_backup(self, reason):
        if self.route["fallback"]:
            return False
        if os.getenv("AD_HF_FALLBACK", "true").lower() != "true" or not os.getenv("HF_TOKEN", "").strip():
            return False
        model_id = os.getenv("AD_HF_BACKUP_MODEL", "Qwen/Qwen3-235B-A22B-Instruct-2507")
        self.active = self.fallback_factory({"enabled": True, "provider": "huggingface",
            "model_id": model_id, "credential_env": "HF_TOKEN",
            "parameters": {"max_tokens": 8192}})
        self.route = {"fallback": True, "provider": "huggingface", "model": model_id, "reason": reason}
        return True

    def generate(self, messages, response_format=None):
        try:
            self.calls += 1
            result = self.active.generate(messages, response_format=response_format)
        except (ModelConfigurationError, ModelExecutionError) as error:
            reason = "configuration" if isinstance(error, ModelConfigurationError) else "timeout" if isinstance(error, ModelTimeout) else error.reason_code
            if not self.use_backup(reason):
                raise
            self.calls += 1
            result = self.active.generate(messages, response_format=response_format)
        self.metrics = getattr(self.active, "metrics", None)
        return result
