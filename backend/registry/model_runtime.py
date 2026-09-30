"""Provider-independent model initialization and text generation."""

import json
import os
import socket
import time
from abc import ABC, abstractmethod
from copy import deepcopy
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ModelConfigurationError(Exception):
    pass


class ModelExecutionError(Exception):
    pass


class ModelTimeout(ModelExecutionError):
    pass


class ModelRuntime(ABC):
    @abstractmethod
    def generate(self, messages):
        """Return assistant text for a list of role/content messages."""


class DemoModel(ModelRuntime):
    def generate(self, messages):
        return f"Demo response (no model inference): {messages[-1]['content']}"


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


HTTP_REASONS = {
    401: "the access token was rejected",
    402: "the account has no inference credits left",
    403: "the access token lacks permission to call this model",
    404: "the model is not served by the provider",
    429: "the provider rate limit was reached; try again shortly",
    503: "the model is overloaded at the provider; try again shortly",
}


class CompatibleChatModel(ModelRuntime):
    """Client for a configured /v1/chat/completions compatible model server."""

    def __init__(self, config, default_url=""):
        self.config = deepcopy(config)
        base_url = (os.getenv(config.get("endpoint_env", ""), "") or default_url).rstrip("/")
        parsed = urlsplit(base_url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ModelConfigurationError("Configure the model's server URL before chatting.")
        self.url = base_url + "/chat/completions"
        # An explicit User-Agent: some providers (Groq) refuse urllib's default one with HTTP 403.
        self.headers = {"Content-Type": "application/json", "User-Agent": "AgentStudio/1.0"}
        credential_env = config.get("credential_env", "")
        if credential_env:
            credential = os.getenv(credential_env)
            if not credential:
                raise ModelConfigurationError("The model's configured credential is missing.")
            self.headers["Authorization"] = f"Bearer {credential}"
        self.opener = build_opener(NoRedirects())

    def generate(self, messages):
        payload = {
            **self.config.get("parameters", {}),
            "model": self.config["model_id"],
            "messages": messages,
            "stream": False,
        }
        # Tool invocation needs a separate authorized service execution layer.
        for key in ("tools", "tool_choice", "functions", "function_call"):
            payload.pop(key, None)
        request = Request(self.url, data=json.dumps(payload).encode(), headers=self.headers, method="POST")
        started = time.monotonic()
        try:
            with self.opener.open(request, timeout=45) as response:
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ModelExecutionError("The model response exceeded the size limit.")
            body = json.loads(raw)
            text = body["choices"][0]["message"]["content"]
            if not isinstance(text, str) or not text.strip():
                raise ModelExecutionError("The model returned no text response.")
            usage = body.get("usage") or {}
            self.metrics = {"latencyMs": round((time.monotonic()-started)*1000),
                            "promptTokens": usage.get("prompt_tokens"), "completionTokens": usage.get("completion_tokens")}
            return text
        except (TimeoutError, socket.timeout) as error:
            raise ModelTimeout("The model timed out. Please try again.") from error
        except HTTPError as error:
            error.close()
            # A safe reason per status; the provider's own text is never returned.
            reason = HTTP_REASONS.get(error.code, "the model server rejected the request")
            raise ModelExecutionError(f"Model call failed: {reason}.") from error
        except URLError as error:
            if isinstance(error.reason, (TimeoutError, socket.timeout)):
                raise ModelTimeout("The model timed out. Please try again.") from error
            raise ModelExecutionError("The model server is unavailable.") from error
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            raise ModelExecutionError("The model returned an invalid response or disconnected.") from error


class HuggingFaceChatModel(CompatibleChatModel):
    def __init__(self, config):
        if not config.get("credential_env"):
            raise ModelConfigurationError("Configure the model's credential environment variable.")
        super().__init__(config, default_url="https://router.huggingface.co/v1")


class ModelRuntimeFactory:
    providers = {"demo": DemoModel, "openai-compatible": CompatibleChatModel, "huggingface": HuggingFaceChatModel}

    @classmethod
    def create(cls, config):
        if not config or not config.get("enabled"):
            raise ModelConfigurationError("This agent has no enabled model configuration.")
        provider = config.get("provider")
        if provider not in cls.providers:
            raise ModelConfigurationError("This model provider is not supported for chat.")
        return DemoModel() if provider == "demo" else cls.providers[provider](config)
