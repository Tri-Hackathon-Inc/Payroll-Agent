"""Fast historical detection, followed by gated agent investigation.

The detector has no model, transport or delivery dependencies. Its state is the
comparable historical payroll snapshot supplied by the event consumer.
"""
from agents.anomaly_detection.interface import AnomalyDetectorInterface
from runtime.common import digest
from agents.anomaly_detection.rules import detect_signals
from runtime.payroll import preprocess


class PayrollAnomalyDetector(AnomalyDetectorInterface):
    def detect(self, context, employee_id=None):
        current, history = context["current"], context["history"]
        evidence = preprocess(current, history, employee_id)
        findings = detect_signals(current, history)
        if employee_id:
            findings = [item for item in findings if item["employeeId"] == employee_id]
        suspicious = [item for item in findings if item["severity"] in ("warning", "critical")]
        return {
            "type": "payroll.anomaly" if suspicious else "payroll.checked",
            "id": digest([current["id"], current.get("version"), suspicious]),
            "detectorVersion": "historical-policy-v1",
            "payrunId": current["id"], "version": current.get("version"),
            "analysis": evidence, "findings": findings, "suspiciousFindings": suspicious,
        }

