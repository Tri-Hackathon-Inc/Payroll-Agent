from unittest.mock import Mock, patch
from django.test import SimpleTestCase
from agents.anomaly_detection.logic import PayrollAnomalyDetector
from agents.anomaly_detection.agent import PayrollAnomalyInvestigator
from runtime.events import process
from tests.test_runtime import fixture


class AnomalySeparationTests(SimpleTestCase):
    def test_detector_emits_evidence_without_calling_an_agent(self):
        context = fixture()
        with patch("runtime.incidents.raise_incidents") as handler:
            result = PayrollAnomalyDetector().detect(context)
        handler.assert_not_called()
        self.assertEqual(result["payrunId"], context["current"]["id"])
        self.assertTrue(result["suspiciousFindings"])
        self.assertEqual(result["type"], "payroll.anomaly")
        self.assertTrue(all(item["severity"] in ("warning", "critical") for item in result["suspiciousFindings"]))
        self.assertEqual(result["id"], PayrollAnomalyDetector().detect(context)["id"])

    def test_investigator_uses_detector_findings_and_skips_normal_results(self):
        context = fixture()
        detection = PayrollAnomalyDetector().detect(context)
        handler = Mock(return_value={"suggested": []})
        investigator = PayrollAnomalyInvestigator(handler)
        investigator.investigate(detection, {}, [], "domain", context)
        handler.assert_called_once_with({}, [], "domain", context, detection["analysis"], detected_findings=detection["suspiciousFindings"])
        handler.reset_mock()
        self.assertEqual(investigator.investigate({**detection, "suspiciousFindings": []}, {}, [], "domain", context), {})
        handler.assert_not_called()

    def test_normal_events_broadcast_checks_without_invoking_investigation(self):
        context = fixture()
        detection = PayrollAnomalyDetector().detect(context)
        detection.update(type="payroll.checked", findings=[], suspiciousFindings=[])
        detector = Mock()
        detector.detect.return_value = detection
        investigator = Mock()
        monitor = {"id": "monitor", "name": "Monitor", "template_id": "anomaly-detection", "config": {"capabilities": {"alerts": {"enabled": True}}}}
        with patch("runtime.events.load_context", return_value=context), \
                patch("runtime.events.services.list_domains", return_value=[{"name": "domain"}]), \
                patch("runtime.events.services.get_service_agent_registry", return_value=[monitor]), \
                patch("runtime.events.broadcast") as broadcast, \
                patch("runtime.events.record"):
            process({"payrunId": context["current"]["id"]}, detector=detector, investigator=investigator)
        investigator.investigate.assert_not_called()
        self.assertEqual(broadcast.call_args.args[0]["type"], "checked")
        self.assertEqual(broadcast.call_args.args[0]["detection"]["type"], "payroll.checked")
