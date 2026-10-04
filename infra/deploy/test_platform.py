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
        # Deployment command tests are independent of installed CLI/daemon state.
        self.addCleanup(patch.stopall)
        patch.object(launcher.shutil, 'which', side_effect=lambda name: name).start()
        patch.object(launcher, 'check_compose', return_value=['docker', 'compose']).start()

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
        with patch.object(launcher.shutil, 'disk_usage', side_effect=AssertionError('unexpected disk check')), \
             patch.object(launcher.shutil, 'which', side_effect=AssertionError('unexpected engine detection')):
            for kube in (False, True):
                for ray in (False, True):
                    config = copy.deepcopy(self.config)
                    config['kubernetes']['enabled'] = kube
                    config['rayServe']['enabled'] = ray
                    launcher.execute(config, 'up', dry_run=True)
            launcher.execute(self.config, 'up', dry_run=True, engine='podman')
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

    @patch.object(launcher, 'provision_kind', side_effect=ValueError('bootstrap invoked'))
    def test_missing_kubeconfig_up_defaults_to_podman(self, provision):
        self.config['kubernetes']['enabled'] = True
        self.config['kubernetes']['kubeconfig'] = 'missing-kubeconfig-for-test'
        with self.assertRaisesRegex(ValueError, 'bootstrap invoked'):
            launcher.execute(self.config, 'up')
        self.assertEqual(provision.call_args.args[2], 'podman')

    @patch.object(launcher, 'provision_kind')
    def test_missing_kubeconfig_status_never_creates_cluster(self, provision):
        self.config['kubernetes']['enabled'] = True
        self.config['kubernetes']['kubeconfig'] = 'missing-kubeconfig-for-test'
        with self.assertRaisesRegex(ValueError, 'not provisioned'):
            launcher.execute(self.config, 'status')
        provision.assert_not_called()

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
        with self.assertRaisesRegex(ValueError, 'Docker or Podman'):
            launcher.check_cluster(['kubectl'])


class ComposeEngineTests(unittest.TestCase):
    def setUp(self):
        self.config = {'kubernetes': {'enabled': False, 'kubeconfig': 'unused'},
                       'rayServe': {'enabled': False}}

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    def test_auto_prefers_docker_and_explicit_podman_overrides(self, which):
        self.assertEqual(launcher.select_engine('auto'), 'docker')
        self.assertEqual(launcher.select_engine('podman'), 'podman')

    @patch.object(launcher.shutil, 'which', return_value=None)
    def test_missing_engines_give_setup_instructions(self, which):
        with self.assertRaisesRegex(ValueError, 'Install Docker.*Podman'):
            launcher.select_engine('auto')
        with self.assertRaisesRegex(ValueError, 'Docker is not installed'):
            launcher.select_engine('docker')

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: None if name == 'docker' else name)
    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='--wait --wait-timeout'))
    def test_missing_docker_starts_podman_with_native_provider_and_env_files(self, run, which):
        with patch.object(Path, 'exists', return_value=True), \
             patch.dict(launcher.os.environ, {'COMPOSE_PROFILES': 'local-model',
                                            'PODMAN_COMPOSE_PROVIDER': 'docker-compose'}):
            launcher.execute(self.config, 'up')
        command = run.call_args.args[0]
        env = run.call_args.kwargs['env']
        self.assertEqual(command[:2], ['podman', 'compose'])
        self.assertIn('--in-pod=false', command)
        self.assertIn('--podman-build-args=--ignorefile=infra/docker/Dockerfile.dockerignore', command)
        self.assertEqual(command[-3:], ['up', '-d', '--wait'])
        self.assertIn('backend/.env', command)
        self.assertIn('.env', command)
        self.assertNotIn('infra/docker/docker-compose.ray.yaml', command)
        self.assertEqual(env['PODMAN_COMPOSE_PROVIDER'], 'podman-compose')
        self.assertEqual(env['COMPOSE_PROFILES'], '')
        self.assertEqual(env['VLLM_BASE_URL'], '')
        self.assertEqual(env['VLLM_API_KEY'], '')
        self.assertTrue(all(call.args[0][0] == 'podman' for call in run.call_args_list))

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='usage'))
    def test_podman_stop_and_status_use_the_same_stack_without_deleting_volumes(self, run, which):
        for action, tail in [('stop', ['stop']), ('status', ['ps', '-a'])]:
            with self.subTest(action=action):
                launcher.execute(self.config, action, engine='podman')
                command = run.call_args.args[0]
                self.assertEqual(command[:2], ['podman', 'compose'])
                self.assertEqual(command[-len(tail):], tail)
                self.assertNotIn('down', command)
                self.assertNotIn('--volumes', command)

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(returncode=1))
    def test_stopped_docker_does_not_switch_engines_or_mutate_workloads(self, run, which):
        with self.assertRaisesRegex(ValueError, 'Docker is not ready'):
            launcher.execute(self.config, 'up')
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ['docker', 'info'])

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    @patch.object(launcher.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=1, stdout='')])
    def test_broken_docker_compose_does_not_fall_back(self, run, which):
        with self.assertRaisesRegex(ValueError, 'working Compose provider'):
            launcher.execute(self.config, 'up')
        self.assertEqual([c.args[0] for c in run.call_args_list], [['docker', 'info'], ['docker', 'compose', 'up', '--help']])

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: None if name == 'podman-compose' else name)
    @patch.object(launcher.subprocess, 'run')
    def test_missing_native_provider_fails_before_any_command(self, run, which):
        with self.assertRaisesRegex(ValueError, 'native podman-compose'):
            launcher.execute(self.config, 'up', engine='podman')
        run.assert_not_called()

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    @patch.object(launcher.subprocess, 'run', side_effect=[SimpleNamespace(returncode=0), SimpleNamespace(returncode=0, stdout='--wait-timeout')])
    def test_old_podman_provider_is_rejected_before_startup(self, run, which):
        with self.assertRaisesRegex(ValueError, '1.6.0'):
            launcher.execute(self.config, 'up', engine='podman')
        self.assertEqual(run.call_count, 2)

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    @patch.object(launcher.subprocess, 'run', side_effect=launcher.subprocess.TimeoutExpired('podman info', 15))
    def test_engine_timeout_is_bounded_and_actionable(self, run, which):
        with self.assertRaisesRegex(ValueError, 'Podman preflight timed out'):
            launcher.execute(self.config, 'status', engine='podman')
        self.assertEqual(run.call_args.kwargs['timeout'], 15)

    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    @patch.object(launcher.subprocess, 'run')
    def test_podman_ray_rejected_before_secret_or_workload_changes(self, run, which):
        self.config['rayServe']['enabled'] = True
        with patch.object(launcher.shutil, 'disk_usage', return_value=SimpleNamespace(free=40*1024**3)), \
             patch.object(Path, 'mkdir') as mkdir, patch.object(Path, 'write_text') as write:
            with self.assertRaisesRegex(ValueError, 'rayServe.enabled=false'):
                launcher.execute(self.config, 'up', engine='podman')
        run.assert_not_called()
        mkdir.assert_not_called()
        write.assert_not_called()

    @patch.object(launcher.subprocess, 'run')
    def test_podman_kubernetes_dry_run_never_probes_or_changes_provider(self, run):
        self.config['kubernetes']['enabled'] = True
        launcher.execute(self.config, 'up', dry_run=True, engine='podman')
        run.assert_not_called()

    @patch.object(launcher, 'check_cluster')
    @patch.object(Path, 'is_file', return_value=True)
    @patch.object(launcher.subprocess, 'run')
    def test_podman_kubernetes_status_uses_only_kubectl(self, run, exists, check):
        self.config['kubernetes']['enabled'] = True
        launcher.execute(self.config, 'status', engine='podman')
        self.assertEqual(run.call_args.args[0][0], 'kubectl')
        self.assertEqual(run.call_args.args[0][-3:], ['get', 'pods', '-A'])


class ProvisionTests(unittest.TestCase):
    @patch.object(launcher, 'check_cluster')
    @patch.object(launcher, 'check_compose', return_value=['podman', 'compose'])
    @patch.object(launcher, 'select_engine', return_value='podman')
    @patch.object(launcher.shutil, 'which', side_effect=lambda name: name)
    def test_create_build_load_secrets_and_apply_order(self, which, select, compose, check):
        services = {name: {'environment': {'PASSWORD': 'private'}} for name in launcher.SERVICES}
        services['backend']['build'] = {'target': 'backend'}
        def result(command, **kwargs):
            if command[:3] == ['podman', 'machine', 'list']:
                return SimpleNamespace(stdout='[{"Name":"test","Running":true}]')
            if command[-1] == 'config':
                return SimpleNamespace(stdout=launcher.json.dumps({'services': services}))
            return SimpleNamespace(stdout='', returncode=0)
        with patch.object(launcher.subprocess, 'run', side_effect=result) as run, \
             patch.object(Path, 'mkdir'), patch.object(Path, 'exists', return_value=False):
            launcher.provision_kind(Path('test-kubeconfig'), {})
        commands = [c.args[0] for c in run.call_args_list]
        create = next(i for i,c in enumerate(commands) if c[:3] == ['kind', 'create', 'cluster'])
        build = next(i for i,c in enumerate(commands) if c[:2] == ['podman', 'build'])
        load = next(i for i,c in enumerate(commands) if c[:3] == ['kind', 'load', 'image-archive'])
        self.assertIn('docker.io/library/payroll-local-backend:latest', commands[build])
        self.assertLess(create, build)
        self.assertLess(build, load)
        self.assertEqual(commands[-1][-1], 'infra/deploy/kind/platform.json')
        self.assertTrue(all('private' not in ' '.join(c) for c in commands))
        self.assertTrue(all(c.kwargs['env']['KIND_EXPERIMENTAL_PROVIDER'] == 'podman' for c in run.call_args_list))


class MachineTests(unittest.TestCase):
    @patch.object(launcher.sys, 'platform', 'darwin')
    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(stdout='[]'))
    def test_mac_initializes_rootful_machine_then_starts(self, run):
        launcher.ensure_podman_machine({})
        commands = [c.args[0] for c in run.call_args_list]
        self.assertIn('--rootful', commands[1])
        self.assertEqual(commands[2], ['podman', 'machine', 'start'])

    @patch.object(launcher.sys, 'platform', 'darwin')
    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(stdout='[{"Name":"mac-vm","Running":false}]'))
    def test_mac_reuses_stopped_machine(self, run):
        launcher.ensure_podman_machine({})
        self.assertEqual(run.call_args.args[0], ['podman', 'machine', 'start', 'mac-vm'])
        self.assertEqual(run.call_count, 2)

    @patch.object(launcher.sys, 'platform', 'darwin')
    @patch.object(launcher.subprocess, 'run', return_value=SimpleNamespace(stdout='[{"Name":"mac-vm","Running":true}]'))
    def test_mac_running_machine_is_unchanged(self, run):
        launcher.ensure_podman_machine({})
        self.assertEqual(run.call_count, 1)

    @patch.object(launcher.sys, 'platform', 'linux')
    @patch.object(launcher.os, 'name', 'posix')
    @patch.object(launcher.subprocess, 'run')
    def test_linux_does_not_create_vm(self, run):
        launcher.ensure_podman_machine({})
        run.assert_not_called()

if __name__ == '__main__':
    unittest.main()
