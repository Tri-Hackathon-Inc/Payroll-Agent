"""Bounded numeric history, reusable across domains without payroll dependencies.

Moments update with each observation. The retained window also supports exact
percentiles, corrections and event-time lookups without reading raw events.
"""
from copy import deepcopy
from math import ceil, sqrt


WINDOW_SIZE = 128


class RollingFeatures:
    def __init__(self, state=None):
        self.state = deepcopy(state or {"samples": [], "count": 0, "mean": 0.0, "m2": 0.0})

    def _add(self, value):
        state = self.state
        state["count"] += 1
        delta = value - state["mean"]
        state["mean"] += delta / state["count"]
        state["m2"] += delta * (value - state["mean"])

    def _remove(self, value):
        state = self.state
        count = state["count"] - 1
        if not count:
            state.update(count=0, mean=0.0, m2=0.0)
        else:
            mean = (state["count"] * state["mean"] - value) / count
            state["m2"] = max(0.0, state["m2"] - (value - state["mean"]) * (value - mean))
            state.update(count=count, mean=mean)

    def remove(self, identity):
        for sample in list(self.state["samples"]):
            if sample["id"] == identity:
                self._remove(sample["value"])
                self.state["samples"].remove(sample)

    def put(self, identity, occurred_at, value):
        self.remove(identity)
        self._add(value)
        self.state["samples"].append({"id": identity, "at": occurred_at, "value": value})
        self.state["samples"].sort(key=lambda item: (item["at"], item["id"]))
        while len(self.state["samples"]) > WINDOW_SIZE:
            self._remove(self.state["samples"].pop(0)["value"])

    def before(self, occurred_at, exclude=None):
        samples = [item for item in self.state["samples"] if item["at"] < occurred_at and item["id"] != exclude]
        if len(samples) == self.state["count"]:
            return self.summary()
        prior = RollingFeatures()
        for item in samples:
            prior.put(item["id"], item["at"], item["value"])
        return prior.summary()

    def summary(self):
        samples, count = self.state["samples"], self.state["count"]
        values = sorted(item["value"] for item in samples)
        variance = max(0.0, self.state["m2"] / (count - 1)) if count > 1 else None
        return {
            "count": count, "mean": self.state["mean"] if count else None,
            "variance": variance, "std": sqrt(variance) if variance is not None else None,
            "min": values[0] if count else None, "max": values[-1] if count else None,
            "p95": values[ceil(0.95 * count) - 1] if count else None,
            "lastValue": samples[-1]["value"] if count else None,
            "lastObservedAt": samples[-1]["at"] if count else None,
            "windowSize": WINDOW_SIZE, "windowFull": count == WINDOW_SIZE,
        }
