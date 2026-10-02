"""Payroll-specific features; additional domains provide their own enricher."""
from runtime.payroll import preprocess
from ..rules import detect_signals


class PayrollFeatureEnricher:
    version = "payroll-history-v1"

    def enrich(self, context, scope=None):
        current, history = context["current"], context["history"]
        policies = detect_signals(current, history)
        if scope:
            policies = [item for item in policies if item["employeeId"] == scope]
        return {"featureSchema": self.version, "current": {"id": current["id"], "version": current.get("version")},
                "analysis": preprocess(current, history, scope), "policies": policies}
