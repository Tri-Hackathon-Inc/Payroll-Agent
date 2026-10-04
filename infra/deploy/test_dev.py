"""Source watcher boundaries and deployment sequencing; no cluster required."""
import importlib.util
import io
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('dev_watcher', Path(__file__).with_name('dev.py'))
dev = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dev)


class WatcherTests(unittest.TestCase):
    def test_reload_routing(self):
        self.assertTrue(dev.can_sync('trinet-ui', {'src/App.jsx'}, {'src/App.jsx': 'hash'}))
        self.assertTrue(dev.can_sync('ui', {'src/App.css'}, {'src/App.css': 'hash'}))
        for service, name in [('backend', 'agents/agent.py'), ('ui', 'src/index.html'),
                              ('ui', 'src/ui-templates/payrun/main.ts'), ('trinet-ui', 'package-lock.json'),
                              ('trinet-ui', '@Dockerfile')]:
            self.assertFalse(dev.can_sync(service, {name}, {name: 'hash'}))
        self.assertFalse(dev.can_sync('trinet-ui', {'src/deleted.jsx'}, {}))

    def test_changed_added_deleted_files(self):
        self.assertEqual(dev.changes({'old': 'a', 'same': 'a', 'edit': 'a'},
                                     {'new': 'a', 'same': 'a', 'edit': 'b'}), {'old', 'new', 'edit'})

    def test_excludes_secrets_artifacts_dependencies_and_archives_relative_paths(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(dev, 'ROOT', Path(temp)):
            root = Path(temp)
            for name in ['ui-trinet-mock/src/a.jsx', 'ui-trinet-mock/.env',
                         'ui-trinet-mock/node_modules/a.js', 'ui-trinet-mock/dist/a.js',
                         'ui-trinet-mock/.local-data/evidence.json', 'infra/docker/Dockerfile']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('source')
            self.assertEqual(set(dev.snapshot('trinet-ui')), {'src/a.jsx', '@Dockerfile'})
            with tarfile.open(fileobj=io.BytesIO(dev.archive('trinet-ui', {'src/a.jsx'}))) as tar:
                self.assertEqual(tar.getnames(), ['src/a.jsx'])

    def test_failed_build_does_not_load_or_restart(self):
        watcher = dev.Watcher.__new__(dev.Watcher)
        watcher.config = {'cluster': 'payroll-agent'}
        watcher.kind, watcher.kube = 'kind', ['kubectl']
        watcher.run = Mock(side_effect=dev.subprocess.CalledProcessError(1, 'build'))
        with self.assertRaises(dev.subprocess.CalledProcessError):
            watcher.rebuild('backend')
        self.assertEqual(watcher.run.call_count, 1)

    def test_build_load_restart_then_wait(self):
        watcher = dev.Watcher.__new__(dev.Watcher)
        watcher.config = {'cluster': 'payroll-agent'}
        watcher.kind, watcher.kube = 'kind', ['kubectl']
        watcher.run = Mock()
        watcher.rebuild('backend')
        commands = [call.args[0] for call in watcher.run.call_args_list]
        self.assertIn('build', commands[0])
        self.assertIn('load', commands[1])
        self.assertIn('restart', commands[2])
        self.assertIn('status', commands[3])
