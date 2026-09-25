"""Provider-independent model initialization and text generation."""

import json
import os
import socket
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


class CompatibleChatModel(ModelRuntime):
    """Client for a configured /v1/chat/completions compatible model server."""

    def __init__(self, config):
        self.config = deepcopy(config)
        base_url = os.getenv(config.get("endpoint_env", ""), "").rstrip("/")
        parsed = urlsplit(base_url)
        if (parsed.scheme not in ("http", "https") or not parsed.hostname
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ModelConfigurationError("Configure the model's server URL before chatting.")
        self.url = base_url + "/chat/completions"
        self.headers = {"Content-Type": "application/json"}
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
        try:
            with self.opener.open(request, timeout=45) as response:
                raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise ModelExecutionError("The model response exceeded the size limit.")
            text = json.loads(raw)["choices"][0]["message"]["content"]
            if not isinstance(text, str) or not text.strip():
                raise ModelExecutionError("The model returned no text response.")
            return text
        except (TimeoutError, socket.timeout) as error:
            raise ModelTimeout("The model timed out. Please try again.") from error
        except HTTPError as error:
            error.close()
            raise ModelExecutionError("The model server rejected the request.") from error
        except URLError as error:
            if isinstance(error.reason, (TimeoutError, socket.timeout)):
                raise ModelTimeout("The model timed out. Please try again.") from error
            raise ModelExecutionError("The model server is unavailable.") from error
        except (OSError, ValueError, KeyError, IndexError, TypeError) as error:
            raise ModelExecutionError("The model returned an invalid response or disconnected.") from error


class ModelRuntimeFactory:
    providers = {"demo": DemoModel, "openai-compatible": CompatibleChatModel}

    @classmethod
    def create(cls, config):
        if not config or not config.get("enabled"):
            raise ModelConfigurationError("This agent has no enabled model configuration.")
        provider = config.get("provider")
        if provider not in cls.providers:
            raise ModelConfigurationError("This model provider is not supported for chat.")
        return DemoModel() if provider == "demo" else cls.providers[provider](config)
