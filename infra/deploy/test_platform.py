"""Startup selection tests: no Docker engine, model download or cluster needed."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('platform_launcher', Path(__file__).with_name('platform.py'))
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)

class DeploymentTests(unittest.TestCase):
    def setUp(self):
        # User configuration may legitimately enable either optional component.
        self.config = {'kubernetes': {'enabled': False, 'kubeconfig': '.local-data/kind-kubeconfig'},
                       'rayServe': {'enabled': False}}

    def test_defaults_disable_both_optional_components(self):
        self.assertFalse(self.config['kubernetes']['enabled'])
        self.assertFalse(self.config['rayServe']['enabled'])

    @patch.object(launcher.subprocess, 'run')
    def test_default_up_never_calls_kubernetes_or_starts_ray(self, run):
        launcher.execute(self.config, 'up')
        commands = [call.args[0] for call in run.call_args_list]
        self.assertTrue(all(command[:2] == ['docker','compose'] for command in commands))
        self.assertEqual(commands[0][-3:], ['stop','model-gateway','ray-serve'])
        self.assertNotIn('--profile', commands[-1])
        self.assertEqual(run.call_args.kwargs['env']['VLLM_BASE_URL'], '')
        self.assertEqual(run.call_args.kwargs['env']['VLLM_API_KEY'], '')

    @patch.object(launcher.subprocess, 'run')
    def test_all_four_modes_support_side_effect_free_preview(self, run):
        with patch.object(launcher.shutil, 'disk_usage', side_effect=AssertionError('unexpected disk check')):
            for kube in (False, True):
                for ray in (False, True):
                    config = copy.deepcopy(self.config)
                    config['kubernetes']['enabled'] = kube
                    config['rayServe']['enabled'] = ray
                    launcher.execute(config, 'up', dry_run=True)
        run.assert_not_called()

    @patch.object(launcher.subprocess, 'run')
    def test_low_disk_blocks_model_before_any_command(self, run):
        self.config['rayServe']['enabled'] = True
        with patch.object(launcher.shutil, 'disk_usage', return_value=SimpleNamespace(free=3*1024**3)):
            with self.assertRaisesRegex(ValueError, '35 GiB'):
                launcher.execute(self.config, 'up')
        run.assert_not_called()

    @patch.object(launcher.subprocess, 'run')
    def test_ray_can_start_without_kubernetes(self, run):
        self.config['rayServe']['enabled'] = True
        with patch.object(launcher.shutil, 'disk_usage', return_value=SimpleNamespace(free=40*1024**3)), \
             patch.object(Path, 'exists', return_value=True), \
             patch.object(Path, 'mkdir'), \
             patch.object(Path, 'read_text', return_value='test-key'):
            launcher.execute(self.config, 'up')
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ['docker','compose'])
        self.assertEqual(command[-5:], ['--profile','local-model','up','-d','--wait'])
        self.assertIn('local-model', command)
        self.assertEqual(run.call_args.kwargs['env']['VLLM_BASE_URL'], 'http://model-gateway:8000/v1')
        self.assertNotIn('test-key', command)

    @patch.object(launcher.subprocess, 'run')
    def test_stop_preserves_volumes_and_includes_disabled_model(self, run):
        launcher.execute(self.config, 'stop')
        command = run.call_args.args[0]
        self.assertEqual(command[-3:], ['--profile','local-model','stop'])
        self.assertNotIn('down', command)

    @patch.object(launcher.subprocess, 'run')
    def test_kind_off_never_requires_kubeconfig(self, run):
        self.config['kubernetes']['kubeconfig'] = 'missing'
        launcher.execute(self.config, 'status')
        self.assertEqual(run.call_args.args[0][:2], ['docker','compose'])

    @patch.object(launcher.subprocess, 'run')
    def test_kind_on_requires_explicit_provisioning(self, run):
        self.config['kubernetes']['enabled'] = True
        self.config['kubernetes']['kubeconfig'] = 'missing-kubeconfig-for-test'
        with self.assertRaisesRegex(ValueError, 'not provisioned'):
            launcher.execute(self.config, 'up')
        run.assert_not_called()

    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stdout=''))
    def test_unreachable_cluster_has_recovery_instructions(self, run):
        with self.assertRaisesRegex(ValueError, 'Do not recreate or delete'):
            launcher.check_cluster(['kubectl'])
        self.assertEqual(run.call_args.kwargs['timeout'], 15)

    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='ok\n'))
    def test_ready_cluster_passes_preflight(self, run):
        launcher.check_cluster(['kubectl'])

    @patch.object(launcher.subprocess, 'run', side_effect=launcher.subprocess.TimeoutExpired('kubectl', 15))
    def test_cluster_timeout_is_actionable(self, run):
        with self.assertRaisesRegex(ValueError, 'Docker Desktop'):
            launcher.check_cluster(['kubectl'])

if __name__ == '__main__':
    unittest.main()
