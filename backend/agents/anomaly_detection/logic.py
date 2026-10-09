"""Fast historical detection, followed by gated agent investigation.

The detector has no model, transport or delivery dependencies. Its state is the
comparable historical payroll snapshot supplied by the event consumer.
"""
from agents.anomaly_detection.interface import AnomalyDetectorInterface
from copy import deepcopy
from runtime.common import digest


def review_finding(item):
    """Expose calculated and policy findings through one display contract."""
    return {
        **item, "name": item.get("employeeName"), "kind": item["code"],
        "detail": item["label"],
        "severity": ("critical" if item["code"] in ("multiple_lines", "terminated_payment", "negative_net")
                     else "warning" if item["severity"] == "review" else item["severity"]),
        # Different indicators can describe the same change. Do not invent or
        # aggregate dollars at risk for median comparisons.
        "amountAtRisk": item.get("amountAtRisk"),
    }


class PayrollAnomalyDetector(AnomalyDetectorInterface):
    def detect(self, context, employee_id=None):
        if "featureSchema" not in context:
            from .features.payroll import PayrollFeatureEnricher
            context = PayrollFeatureEnricher().enrich(context, employee_id)
        current = context["current"]
        evidence = deepcopy(context["analysis"])
        policies = context["policies"]
        # Preserve calculated IDs and amounts; include payrun-wide findings in
        # the same list that response validation requires the model to cover.
        evidence["findings"].extend({
            **item, "employeeId": None, "employeeName": "Payrun " + current["id"],
            "code": item["id"].split(":", 1)[-1], "lineIds": [],
        } for item in evidence["payrunFindings"])
        evidence["findings"].extend({
            "id": f"{item['employeeId']}:policy:{digest([item['kind'], item['evidence']])[:20]}",
            "employeeId": item["employeeId"], "employeeName": item["name"],
            "code": item["kind"], "label": item["detail"], "severity": item["severity"],
            "lineIds": item["evidence"].get("lineIds", []), "evidence": item["evidence"],
            "amountAtRisk": item["amountAtRisk"],
        } for item in policies)
        findings = [review_finding(item) for item in evidence["findings"]]
        suspicious = [item for item in findings if item["severity"] in ("warning", "critical")]
        decision = "CRITICAL" if any(item["severity"] == "critical" for item in suspicious) else "REVIEW" if suspicious else "NORMAL"
        summary = (f"{len(suspicious)} payroll finding(s) need review."
                   if suspicious else "No review findings detected in the available payroll data.")
        if any(item["historyStatus"] != "available" for item in evidence["employees"]):
            summary += " Historical comparisons are limited for some employees."
        return {
            "type": "payroll.anomaly" if suspicious else "payroll.checked",
            "id": digest([current["id"], current.get("version"), employee_id, "historical-policy-v2", findings]),
            "detectorVersion": "historical-policy-v2", "decision": decision, "summary": summary,
            "payrunId": current["id"], "version": current.get("version"),
            "analysis": evidence, "findings": findings, "suspiciousFindings": suspicious,
        }
