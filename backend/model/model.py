"""Agent-facing model implementation; credentials remain inside provider clients."""
from copy import deepcopy
from model.interface import ModelInterface
from model.runtime import ModelRuntimeFactory


class Model(ModelInterface):
    def __init__(self, configuration, runtime_factory=None):
        self.configuration = deepcopy(configuration)
        self.runtime_factory = runtime_factory or ModelRuntimeFactory
        self.metrics = None

    def generate(self, messages, response_format=None):
        config = deepcopy(self.configuration)
        if response_format:
            config.setdefault("parameters", {})["response_format"] = response_format
        runtime = self.runtime_factory.create(config)
        text = runtime.generate(messages)
        self.metrics = getattr(runtime, "metrics", None)
        return text
