"""Investigate suspicious findings using configured agent action policies."""
from agents.anomaly_detection.interface import AnomalyInvestigatorInterface


class PayrollAnomalyInvestigator(AnomalyInvestigatorInterface):
    def __init__(self, incident_handler=None):
        self.incident_handler = incident_handler

    def investigate(self, anomaly, monitor, agents, domain_name, context):
        if not anomaly["suspiciousFindings"]:
            return {}
        handler = self.incident_handler
        if handler is None:
            from runtime.incidents import raise_incidents
            handler = raise_incidents
        return handler(monitor, agents, domain_name, context, anomaly["analysis"],
                       detected_findings=anomaly["suspiciousFindings"]) or {}
