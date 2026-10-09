"""Cheap rules and statistical scoring over supplied features; no history fetches."""
from dataclasses import dataclass
import math

from runtime.common import digest


@dataclass(frozen=True)
class RangeRule:
    """Domain adapters register business limits in code, never in event payloads."""
    metric: str
    minimum: float | None = None
    maximum: float | None = None
    severity: str = "warning"

    def evaluate(self, measurement):
        value = measurement["value"]
        if measurement["name"] != self.metric or value is None:
            return None
        if (self.minimum is not None and value < self.minimum) or (self.maximum is not None and value > self.maximum):
            return {"code": "range_rule", "label": f"{self.metric} is outside the configured limits.",
                    "severity": self.severity, "score": 1.0 if self.severity == "critical" else 0.5,
                    "evidence": {"current": value, "minimum": self.minimum, "maximum": self.maximum}}
        return None


class RecordDetector:
    version = "record-statistics-v1"

    def __init__(self, rules=(), decision_model=None):
        self.rules = rules
        # An optional Jev/ML adapter implements score(features). It receives only
        # prepared measurements/baselines, not data-access tools or raw history.
        self.decision_model = decision_model

    def detect(self, features, employee_id=None):
        record = features["record"]
        findings, limited = [], False
        for measurement, baseline in zip(record["measurements"], features["baselines"], strict=True):
            value = measurement["value"]
            limited |= baseline["count"] < 3 or value is None
            signals = [result for rule in self.rules if (result := rule.evaluate(measurement))]
            if value is not None and baseline["count"] >= 3:
                delta = value - baseline["mean"]
                std = baseline["std"]
                z_score = abs(delta) / std if std else None
                # A zero-variance baseline is not infinite statistical confidence.
                if (z_score is not None and z_score >= 3) or (not std and abs(delta) > max(abs(baseline["mean"]) * 0.25, 1e-6)):
                    signals.append({"code": "statistical_outlier", "label": f"{measurement['name']} differs from its historical baseline.",
                                    "severity": "critical" if z_score is not None and z_score >= 6 else "warning",
                                    "score": min(1.0, z_score / 6) if z_score is not None else 0.5,
                                    "evidence": {"current": value, "delta": delta, "zScore": z_score, "baseline": baseline}})
            for signal in signals:
                findings.append({**signal, "id": digest([self.version, measurement["name"], measurement["dimensions"], signal]),
                                 "metric": measurement["name"], "unit": measurement["unit"], "dimensions": measurement["dimensions"],
                                 "detail": signal["label"], "kind": signal["code"], "amountAtRisk": None})
        model_status = "not_configured"
        if self.decision_model is not None:
            try:
                prediction = self.decision_model.score({"record": record, "baselines": features["baselines"]})
                score = prediction["score"]
                decision = prediction["decision"]
                if (isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score)
                        or not 0 <= score <= 1 or decision not in ("NORMAL", "REVIEW", "CRITICAL")):
                    raise ValueError("Invalid model decision")
                model_status = "completed"
                if decision != "NORMAL":
                    findings.append({"id": digest([self.version, "decision-model", prediction]), "code": "decision_model",
                                     "kind": "decision_model", "label": "The configured decision model requests review.",
                                     "detail": "The configured decision model requests review.", "severity": "critical" if decision == "CRITICAL" else "warning",
                                     "score": score, "evidence": {"score": score}, "amountAtRisk": None})
            except Exception:
                model_status = "unavailable"
        decision = "CRITICAL" if any(item["severity"] == "critical" for item in findings) else "REVIEW" if findings else "NORMAL"
        summary = f"{len(findings)} finding(s) need review." if findings else "No review findings detected in the supplied measurements."
        if limited:
            summary += " Some measurements have missing values or fewer than three prior observations."
        if model_status == "unavailable":
            summary += " Decision model unavailable; rules and statistics were used."
        return {"id": digest([self.version, record, features["baselines"], findings]), "type": "record.anomaly" if findings else "record.checked",
                "detectorVersion": self.version, "decision": decision, "summary": summary,
                "score": max((item["score"] for item in findings), default=0.0), "scoreType": "heuristic_not_probability",
                "analysis": {"entityId": record["entityId"], "entityType": record["entityType"], "findings": findings,
                             "historyStatus": "limited" if limited else "available", "decisionModelStatus": model_status,
                             "measurements": record["measurements"], "baselines": features["baselines"]},
                "findings": findings, "suspiciousFindings": findings}
