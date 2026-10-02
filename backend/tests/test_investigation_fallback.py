import os
from unittest.mock import Mock, patch

from django.test import SimpleTestCase
from agents.anomaly_detection.fallback import InvestigationModel
from model.runtime import ModelExecutionError


@patch.dict(os.environ, HF_TOKEN="test-only", AD_HF_FALLBACK="true")
class InvestigationFallbackTests(SimpleTestCase):
    def test_credit_failure_uses_huggingface_and_repair_stays_on_backup(self):
        primary = Mock(generate=Mock(side_effect=ModelExecutionError("private", reason_code="credits")))
        backup = Mock(generate=Mock(return_value="validated response"), metrics={"completionTokens": 10})
        factory = Mock(return_value=backup)
        model = InvestigationModel(primary, fallback_factory=factory)
        self.assertEqual(model.generate([], {"type": "json_object"}), "validated response")
        model.generate([])
        self.assertEqual(primary.generate.call_count, 1)
        self.assertEqual(backup.generate.call_count, 2)
        self.assertEqual(model.calls, 3)
        self.assertEqual(model.route["reason"], "credits")
        self.assertEqual(factory.call_args.args[0]["model_id"], "Qwen/Qwen3-235B-A22B-Instruct-2507")
        self.assertEqual(factory.call_args.args[0]["provider"], "huggingface")
        self.assertEqual(factory.call_args.args[0]["credential_env"], "HF_TOKEN")
        self.assertEqual(model.route["provider"], "huggingface")
        self.assertNotIn("private", str(model.route))

    def test_primary_success_never_constructs_backup(self):
        factory = Mock()
        model = InvestigationModel(Mock(generate=Mock(return_value="answer")), fallback_factory=factory)
        self.assertEqual(model.generate([]), "answer")
        factory.assert_not_called()
        self.assertFalse(model.route["fallback"])

    def test_backup_failure_stops_without_loop(self):
        error = ModelExecutionError("No credits", reason_code="credits")
        primary = Mock(generate=Mock(side_effect=error))
        backup = Mock(generate=Mock(side_effect=error))
        model = InvestigationModel(primary, fallback_factory=Mock(return_value=backup))
        with self.assertRaises(ModelExecutionError):
            model.generate([])
        self.assertEqual(model.calls, 2)

    def test_disabled_or_missing_key_never_calls_backup(self):
        for env in ({"AD_HF_FALLBACK": "false"}, {"HF_TOKEN": ""}):
            with patch.dict(os.environ, env):
                factory = Mock()
                model = InvestigationModel(Mock(generate=Mock(side_effect=ModelExecutionError("Unavailable"))), fallback_factory=factory)
                with self.assertRaises(ModelExecutionError):
                    model.generate([])
                factory.assert_not_called()
