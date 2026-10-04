"""Compose a registered decision model after deterministic detection."""
from copy import deepcopy
import math

from runtime.common import digest


class DecisionModelFailure(Exception):
    def __init__(self, status, reason):
        self.status, self.reason = status, reason
        super().__init__(reason)


def probability(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and 0 <= value <= 1


class DecisionModelDetector:
    def __init__(self, detector, model, identity):
        self.detector, self.decision_model, self.identity = detector, model, identity
        provider = getattr(model, "provider", None)
        self.cache_key = digest(["decision-pipeline-v1", identity, model.version, provider if isinstance(provider, str) else None])

    def detect_preview(self, features, scope=None):
        result = self.detector.detect(features, scope)
        result["analysis"]["decisionModelStatus"] = "skipped"
        return result

    def detect(self, features, scope=None):
        result = self.detector.detect(deepcopy(features), scope)
        metadata = {"adapter": self.identity, "model": self.decision_model.version}
        try:
            prediction = self.decision_model.score(deepcopy(features))
            if (not isinstance(prediction, dict) or prediction.get("decision") not in ("NORMAL", "REVIEW", "CRITICAL")
                    or not probability(prediction.get("score"))):
                raise DecisionModelFailure("invalid_response", "The decision model returned an invalid decision or score.")
            metadata.update(prediction, status="completed")
        except DecisionModelFailure as error:
            metadata.update(status=error.status, reason=error.reason)
        except Exception:
            # Provider errors can contain authorization headers or source data.
            metadata.update(status="unavailable", reason="The decision service is unavailable. Rules and statistics were retained.")
        result["analysis"]["decisionModelStatus"] = metadata["status"]
        result["analysis"]["decisionModel"] = metadata
        if metadata["status"] == "completed" and metadata["decision"] != "NORMAL":
            finding = {"id": "decision-model:" + digest(metadata), "code": "decision_model", "kind": "decision_model",
                       "label": "The decision model requests review.", "detail": "The decision model requests review.",
                       "employeeId": None, "employeeName": "Decision model", "lineIds": [],
                       "severity": "critical" if metadata["decision"] == "CRITICAL" else "warning",
                       "evidence": metadata, "amountAtRisk": None, "score": metadata["score"]}
            # The investigator's saved analysis must include the model's finding too.
            result["findings"] = [*result["findings"], finding]
            result["suspiciousFindings"] = [*result.get("suspiciousFindings", []), finding]
            result["analysis"]["findings"] = [*result["analysis"].get("findings", []), finding]
            if result["decision"] != "CRITICAL":
                result["decision"] = metadata["decision"]
            result["summary"] = f"{len(result['suspiciousFindings'])} finding(s) need review, including a decision-model finding."
            result["type"] = result["type"].replace(".checked", ".anomaly")
        elif metadata["status"] != "completed":
            result["summary"] += " " + metadata["reason"]
        # Failed and successful evaluations of the same source must not share a case.
        result["id"] = digest([result["id"], metadata])
        return result
