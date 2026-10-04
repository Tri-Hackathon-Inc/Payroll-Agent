"""Optional Kind development watcher: sync UI source, rebuild other changes."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import time
import tempfile
import shutil
from platform import select_engine, check_compose

ROOT = Path(__file__).resolve().parents[2]
SOURCES = {'backend': 'backend', 'ui': 'ui-payroll-agent', 'trinet-ui': 'ui-trinet-mock'}
SKIP = {'node_modules', 'dist', '.angular', 'out-tsc', '__pycache__', '.venv', '.git', '.local-data', 'tests'}
EXTENSIONS = {'.py', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.html', '.css', '.scss', '.svg', '.png', '.jpg', '.woff', '.woff2', '.ico', '.proto', '.graphql', '.sql', '.lock', '.txt'}


def snapshot(service):
    """Only development source; never copy credentials, databases or artifacts."""
    base = ROOT / SOURCES[service]
    result = {}
    for folder, dirs, files in os.walk(base, followlinks=False):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith('.') and not (Path(folder) / d).is_symlink()]
        if service == 'backend' and Path(folder) == base:
            dirs[:] = [d for d in dirs if d not in {'trinet_mock', 'evidence_capture'}]
        for name in files:
            path = Path(folder) / name
            if path.is_symlink() or name.startswith('.') or path.suffix not in EXTENSIONS:
                continue
            if path.suffix == '.txt' and name != 'requirements.txt':
                continue
            relative = path.relative_to(base).as_posix()
            result[relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    # A Dockerfile edit always rebuilds. It is never synced into a container.
    result['@Dockerfile'] = hashlib.sha256((ROOT / 'infra/docker/Dockerfile').read_bytes()).hexdigest()
    return result


def changes(before, after):
    return {name for name in before.keys() | after.keys() if before.get(name) != after.get(name)}


def can_sync(service, changed, after):
    if service == 'backend' or not changed or any(name not in after for name in changed):
        return False
    # Angular prepares its index and builds embedded templates only at startup.
    return all(name.startswith(('src/', 'public/')) and not
               (service == 'ui' and (name == 'src/index.html' or name.startswith('src/ui-templates/')))
               for name in changed)


def archive(service, names):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w') as tar:
        for name in sorted(names):
            path = ROOT / SOURCES[service] / name
            if path.is_symlink() or not path.resolve().is_relative_to((ROOT / SOURCES[service]).resolve()):
                raise ValueError('Source path escaped its project.')
            tar.add(path, arcname=name, recursive=False)
    return data.getvalue()


class Watcher:
    def __init__(self, config, engine='auto'):
        self.config = config
        self.engine = engine
        self.env = os.environ.copy()
        platform = json.loads((ROOT / 'infra/deploy/platform.json').read_text(encoding='utf-8'))
        if not platform['kubernetes']['enabled']:
            raise ValueError('This watcher requires kubernetes.enabled=true in infra/deploy/platform.json.')
        self.kube = ['kubectl', '--kubeconfig', str(ROOT / platform['kubernetes']['kubeconfig']), '-n', config['namespace']]
        self.kind = shutil.which('kind') or (str(ROOT / '.local-data/tools/kind.exe') if os.name == 'nt' else 'kind')

    def run(self, command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=self.env, check=True, timeout=600, **kwargs)

    def pod(self, service):
        data = json.loads(self.run(self.kube + ['get', 'pods', '-l', 'app=' + service, '-o', 'json'], capture_output=True).stdout)
        ready = [p for p in data['items'] if not p['metadata'].get('deletionTimestamp') and
                 any(c['type'] == 'Ready' and c['status'] == 'True' for c in p.get('status', {}).get('conditions', []))]
        if len(ready) != 1:
            raise ValueError(f'{service}: expected one ready development pod; found {len(ready)}.')
        pod = ready[0]
        # Container restarts also lose synced files, even if the pod name is unchanged.
        statuses = pod.get('status', {}).get('containerStatuses', [])
        return pod['metadata']['name'], tuple((s['name'], s.get('containerID')) for s in statuses)

    def rebuild(self, service):
        print(f'{service}: rebuilding and deploying (brief interruption).', flush=True)
        self.run(self.compose + ['-f', 'infra/docker/docker-compose.yaml', 'build', service])
        image = f'payroll-local-{service}:latest'
        if self.engine == 'podman':
            canonical = 'docker.io/library/' + image
            self.run(['podman', 'tag', 'localhost/' + image, canonical])
            image = canonical
            # An archive preserves the exact tag referenced by the Kubernetes manifest.
            with tempfile.TemporaryDirectory(prefix='payroll-kind-') as temp:
                archive_path = str(Path(temp) / 'image.tar')
                self.run(['podman', 'save', '--format', 'docker-archive', '--output', archive_path, image])
                self.run([self.kind, 'load', 'image-archive', archive_path, '--name', self.config['cluster']])
        else:
            self.run([self.kind, 'load', 'docker-image', image, '--name', self.config['cluster']])
        self.run(self.kube + ['rollout', 'restart', 'deployment/' + service])
        self.run(self.kube + ['rollout', 'status', 'deployment/' + service, '--timeout=180s'])

    def sync(self, service, changed, pod):
        self.run(self.kube + ['exec', '-i', pod, '-c', service, '--', 'tar', '-xf', '-', '-C', '/app'],
                 input=archive(service, changed))
        print(f'{service}: synced {len(changed)} source file(s); dev server reloading.', flush=True)

    def watch(self, once=False):
        context = self.run(self.kube[:3] + ['config', 'current-context'], capture_output=True, text=True).stdout.strip()
        if context != 'kind-' + self.config['cluster']:
            raise ValueError('Kubeconfig context must match the configured Kind cluster.')
        self.engine = select_engine(self.engine)
        self.env['KIND_EXPERIMENTAL_PROVIDER'] = self.engine
        self.compose = check_compose(self.engine, self.env, 'build')
        previous, pods = {}, {}
        # Establish a reproducible baseline, including removals since the last run.
        for service in self.config['services']:
            baseline = snapshot(service)
            self.rebuild(service)
            previous[service], pods[service] = baseline, self.pod(service)
        if once:
            return
        print('Watching source. Save a file to reload; Ctrl+C stops watching and leaves the platform running.', flush=True)
        while True:
            time.sleep(self.config['pollSeconds'])
            for service in self.config['services']:
                try:
                    current = snapshot(service)
                    changed = changes(previous[service], current)
                    pod = self.pod(service)
                    if not changed and pod == pods[service]:
                        continue
                    time.sleep(self.config['debounceSeconds'])
                    if snapshot(service) != current:
                        continue  # Wait for this edit burst to finish.
                    if pod != pods[service] or not can_sync(service, changed, current):
                        self.rebuild(service)
                        pod = self.pod(service)
                    else:
                        self.sync(service, changed, pod[0])
                    previous[service], pods[service] = current, pod
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    print(f'{service}: update not applied; will retry. {error}', flush=True)
                    time.sleep(5)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=ROOT / 'infra/deploy/dev.json')
    parser.add_argument('--engine', choices=['auto', 'docker', 'podman'], default='auto',
                        help='Build engine and provider of the existing Kind cluster.')
    parser.add_argument('--once', action='store_true', help='Build/deploy once, then exit.')
    parser.add_argument('--dry-run', action='store_true', help='Show watched projects without changing anything.')
    args = parser.parse_args()
    try:
        config = json.loads(args.config.read_text(encoding='utf-8'))
        if (not config['services'] or any(s not in SOURCES for s in config['services'])
                or not 1 <= config['pollSeconds'] <= 60 or not 0.2 <= config['debounceSeconds'] <= 10):
            raise ValueError('Choose backend/ui/trinet-ui; pollSeconds 1-60; debounceSeconds 0.2-10.')
        watcher = Watcher(config, args.engine)
        if args.dry_run:
            for service in config['services']:
                print(f'{service}: {len(snapshot(service)) - 1} watched files; ' + ('automatic rebuild/redeploy' if service == 'backend' else 'UI source sync; other edits rebuild/redeploy'))
            return
        watcher.watch(args.once)
    except KeyboardInterrupt:
        print('\nWatcher stopped. Platform remains running.')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, f'Development watcher failed: {error}\n')


if __name__ == '__main__':
    main()
