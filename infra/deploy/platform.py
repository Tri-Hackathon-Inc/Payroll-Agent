"""Config-driven startup, including first-time Podman Kind provisioning."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import sys
import base64

ROOT = Path(__file__).resolve().parents[2]
SERVICES = ['db', 'vector-db', 'redis', 'backend', 'ui', 'trinet-mock', 'trinet-ui', 'evidence-capture']

def read_config(path):
    config = json.loads(path.read_text(encoding='utf-8'))
    if set(config) != {'kubernetes', 'rayServe'}:
        raise ValueError('Config must contain only kubernetes and rayServe.')
    for section in ('kubernetes', 'rayServe'):
        if type(config[section].get('enabled')) is not bool:
            raise ValueError(f'{section}.enabled must be true or false.')
    if set(config['kubernetes']) != {'enabled', 'kubeconfig'} or set(config['rayServe']) != {'enabled'}:
        raise ValueError('Unexpected or missing configuration field.')
    if not isinstance(config['kubernetes']['kubeconfig'], str) or not config['kubernetes']['kubeconfig']:
        raise ValueError('kubernetes.kubeconfig must be a path.')
    return config

def plan(config, action, engine='auto'):
    target = 'Kubernetes (reuse configured cluster; provision Podman Kind if missing)' if config['kubernetes']['enabled'] else {
        'auto': 'Compose (Docker when installed, otherwise Podman)',
        'docker': 'Docker Compose', 'podman': 'Podman Compose'}[engine]
    model = 'enabled' if config['rayServe']['enabled'] else 'disabled (no model download)'
    return f'{action}: {target}; Ray Serve: {model}'

def select_engine(requested):
    """Only a missing Docker executable triggers fallback, never a stopped daemon."""
    if requested not in ('auto', 'docker', 'podman'):
        raise ValueError('Engine must be auto, docker or podman.')
    if requested == 'auto':
        requested = 'docker' if shutil.which('docker') else 'podman'
    if not shutil.which(requested):
        raise ValueError(f'{requested.capitalize()} is not installed or not on PATH. '
                         'Install Docker with Compose, or Podman with podman-compose. See README.')
    return requested

def check_compose(engine, env, action):
    """Read-only checks run before keys, containers or model workloads change."""
    command = [engine, 'compose']
    if engine == 'podman':
        provider = shutil.which('podman-compose')
        if not provider:
            raise ValueError('Podman requires the native podman-compose provider on PATH. '
                             'Install podman-compose 1.6.0 or newer; see README.')
        # Match podman.sh: Docker Compose cannot accept the native build flags.
        env['PODMAN_COMPOSE_PROVIDER'] = provider
        command += ['--in-pod=false',
                    '--podman-build-args=--ignorefile=infra/docker/Dockerfile.dockerignore']
    try:
        ready = subprocess.run([engine, 'info'], cwd=ROOT, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        if ready.returncode != 0:
            raise ValueError(f'{engine.capitalize()} is not ready. Start its engine '
                             '(podman machine start on Windows/macOS for Podman). '
                             'No containers were changed and no other engine was selected.')
        # --wait is essential: older native providers return before health checks pass.
        help_result = subprocess.run(command + (['up', '--help'] if action == 'up' else ['--help']),
                                     cwd=ROOT, env=env, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        raise ValueError(f'{engine.capitalize()} preflight timed out. Check its engine and Compose provider.') from None
    if help_result.returncode != 0 or (action == 'up' and '--wait' not in help_result.stdout.split()):
        raise ValueError('A working Compose provider is required (with up --wait for startup). '
                         'Install Docker Compose v2 or native podman-compose 1.6.0 or newer. '
                         'Use --engine podman to explicitly select Podman; see README.')
    return command

def check_cluster(kube):
    """Fail promptly with recovery steps before changing any cluster workloads."""
    message = ('The Kubernetes API is not ready. Check the cluster selected by the configured '
               'kubeconfig. For Kind, start its Docker or Podman engine and inspect its node '
               'with docker/podman ps -a. Start the existing stopped node with the same engine. '
               'Do not recreate or delete the cluster; it contains platform data.')
    try:
        result = subprocess.run(kube + ['--request-timeout=10s', 'get', '--raw=/readyz'],
                                cwd=ROOT, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        raise ValueError(message) from None
    if result.returncode != 0 or result.stdout.strip() != 'ok':
        raise ValueError(message)

def ensure_podman_machine(env):
    """Mac and Windows use a Linux VM; native Linux/WSL use the local engine."""
    if os.name != 'nt' and sys.platform != 'darwin':
        return
    def run(command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **kwargs)
    machines = json.loads(run(['podman', 'machine', 'list', '--format', 'json'],
                              capture_output=True, text=True).stdout)
    if not machines:
        run(['podman', 'machine', 'init', '--rootful', '--cpus', '4',
             '--memory', '8192', '--disk-size', '50'])
        run(['podman', 'machine', 'start'])
    elif len(machines) == 1 and not machines[0].get('Running'):
        run(['podman', 'machine', 'start', machines[0]['Name']])
    elif len(machines) > 1 and not any(machine.get('Running') for machine in machines):
        raise ValueError('Multiple Podman machines exist. Start the intended machine and select its connection first.')


def provision_kind(kubeconfig, env, engine='podman'):
    """Create or resume a dedicated Kind cluster, then deploy application resources."""
    try:
        import yaml
    except ImportError:
        raise ValueError('First-time Kind setup requires PyYAML: python -m pip install PyYAML.') from None
    engine = select_engine(engine)
    kind = shutil.which('kind')
    bundled = ROOT / '.local-data/tools/kind.exe'
    if not kind and os.name == 'nt' and bundled.is_file():
        kind = str(bundled)
    if not kind or not shutil.which('kubectl'):
        raise ValueError('Install Kind and kubectl on PATH before first-time startup.')
    env['KIND_EXPERIMENTAL_PROVIDER'] = engine
    def run(command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **kwargs)
    if engine == 'podman':
        ensure_podman_machine(env)
    compose = check_compose(engine, env, 'build') + ['-f', 'infra/docker/docker-compose.yaml']
    for path in ('.env', 'backend/.env'):
        if (ROOT / path).exists():
            compose += ['--env-file', path]
    rendered = run(compose + ['config'], capture_output=True, text=True)
    settings = yaml.safe_load(rendered.stdout)
    cluster = 'payroll-agent'
    clusters = run([kind, 'get', 'clusters'], capture_output=True, text=True).stdout.split()
    kubeconfig.parent.mkdir(parents=True, exist_ok=True)
    if cluster not in clusters:
        run([kind, 'create', 'cluster', '--config', 'infra/deploy/kind/cluster.yaml',
             '--kubeconfig', str(kubeconfig), '--wait', '180s'])
    else:
        run([kind, 'export', 'kubeconfig', '--name', cluster, '--kubeconfig', str(kubeconfig)])
    kube = ['kubectl', '--kubeconfig', str(kubeconfig)]
    check_cluster(kube)
    built = [name for name in SERVICES if settings['services'][name].get('build')]
    # Explicit tags match the manifest, independent of Compose provider naming.
    for name in built:
        image = f'docker.io/library/payroll-local-{name}:latest'
        build = [engine, 'build', '-f', 'infra/docker/Dockerfile', '--target', name, '-t', image]
        if engine == 'podman':
            build += ['--ignorefile', 'infra/docker/Dockerfile.dockerignore']
        run(build + ['.'])
        with tempfile.TemporaryDirectory(prefix='payroll-kind-') as temp:
            archive = str(Path(temp) / 'image.tar')
            run([engine, 'save', '--format', 'docker-archive', '--output', archive, image]
                if engine == 'podman' else [engine, 'save', '--output', archive, image])
            run([kind, 'load', 'image-archive', archive, '--name', cluster])
    namespace = {'apiVersion': 'v1', 'kind': 'Namespace', 'metadata': {'name': 'payroll'}}
    run(kube + ['apply', '-f', '-'], input=json.dumps(namespace).encode())
    for name in ('db', 'vector-db', 'backend', 'trinet-mock'):
        values = settings['services'][name].get('environment', {})
        secret = {'apiVersion': 'v1', 'kind': 'Secret',
                  'metadata': {'name': name + '-env', 'namespace': 'payroll'},
                  'type': 'Opaque', 'stringData': {k: str(v) for k, v in values.items() if v is not None}}
        run(kube + ['apply', '-f', '-'], input=json.dumps(secret).encode())
    run(kube + ['apply', '-f', 'infra/deploy/kind/platform.json'])


def sync_model_credentials(kube, env):
    """Refresh model credentials without replacing other application Secret entries."""
    from dotenv import dotenv_values
    values = {}
    for name in ('.env', 'backend/.env'):
        path = ROOT / name
        if path.is_file():
            values.update(dotenv_values(path))
    values.update(env)
    keys = {'JEV_PROVIDER', 'JEV_MODEL', 'JEV_TIMEOUT_SECONDS', 'TYPESAFE_API_KEY'}
    for path in (ROOT / 'backend/templates/Model_config').glob('*.json'):
        model = json.loads(path.read_text(encoding='utf-8'))
        keys.update(model.get(field) for field in ('credential_env', 'endpoint_env') if model.get(field))
    updates = {key: base64.b64encode(str(values[key] or '').encode()).decode()
               for key in keys if key in values}
    if not updates:
        return
    def run(command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **kwargs)
    result = run(kube + ['-n', 'payroll', 'get', 'secret', 'backend-env', '-o', 'json'],
                 capture_output=True, text=True)
    secret = json.loads(result.stdout)
    data = secret.setdefault('data', {})
    if all(data.get(key) == value for key, value in updates.items()):
        return
    data.update(updates)
    secret['metadata'] = {'name': 'backend-env', 'namespace': 'payroll'}
    run(kube + ['apply', '-f', '-'], input=json.dumps(secret).encode(), stdout=subprocess.DEVNULL)
    run(kube + ['-n', 'payroll', 'rollout', 'restart', 'deployment/backend'])
    print('Updated backend model environment; credential values were not printed.', flush=True)


def execute(config, action, dry_run=False, engine='auto'):
    print(plan(config, action, engine), flush=True)
    if dry_run:
        return
    use_kube = config['kubernetes']['enabled']
    use_ray = config['rayServe']['enabled']
    # Fail before any model pull or workload change.
    if action == 'up' and use_ray:
        if shutil.disk_usage(ROOT).free < 35 * 1024**3:
            raise ValueError('Ray Serve startup requires at least 35 GiB free. Model download was not started.')
    env = os.environ.copy()
    # Do not let the shell or an env file opt into model downloads.
    env['COMPOSE_PROFILES'] = ''
    command = None
    if not use_kube:
        engine = select_engine(engine)
        print(f'Using {engine.capitalize()} Compose.', flush=True)
        if engine == 'podman' and use_ray and action == 'up':
            raise ValueError('Podman startup currently requires rayServe.enabled=false. '
                             'Use a configured model endpoint, or Docker/Kind for optional Ray Serve.')
        command = check_compose(engine, env, action)
    key = ''
    if action == 'up' and use_ray:
        path = ROOT / '.local-data/vllm-api-key'
        path.parent.mkdir(exist_ok=True)
        if not path.exists():
            path.write_text(secrets.token_urlsafe(48), encoding='utf-8')
        key = path.read_text(encoding='utf-8').strip()
        if not key:
            raise ValueError('Local model key is empty.')
    env['VLLM_API_KEY'] = key
    env['VLLM_BASE_URL'] = ('http://slm-inference.agent-models.svc.cluster.local:8000/v1' if use_kube else 'http://model-gateway:8000/v1') if use_ray else ''
    def run(command, **kwargs):
        return subprocess.run(command, cwd=ROOT, env=env, check=True, **kwargs)
    if not use_kube:
        command += ['-f', 'infra/docker/docker-compose.yaml']
        if engine == 'docker':
            command += ['-f', 'infra/docker/docker-compose.ray.yaml']
        for path in ('.env', 'backend/.env'):
            if (ROOT / path).exists():
                command += ['--env-file', path]
        model_profile = ['--profile', 'local-model'] if engine == 'docker' else []
        if action == 'status':
            run(command + model_profile + ['ps', '-a'])
        elif action == 'stop':
            run(command + model_profile + ['stop'])
        else:
            if not use_ray and engine == 'docker':
                run(command + ['--profile', 'local-model', 'stop', 'model-gateway', 'ray-serve'])
            run(command + (['--profile', 'local-model'] if use_ray else []) + ['up', '-d', '--wait'])
        return
    kubeconfig = ROOT / config['kubernetes']['kubeconfig']
    if not kubeconfig.is_file():
        if action != 'up':
            raise ValueError('Kind is not provisioned. Run platform.py up first.')
        provision_kind(kubeconfig, env, 'podman' if engine == 'auto' else engine)
    if action == 'up' and engine == 'podman':
        ensure_podman_machine(env)
    kube = ['kubectl', '--kubeconfig', str(kubeconfig)]
    check_cluster(kube)
    if action == 'status':
        run(kube + ['get', 'pods', '-A'])
        return
    if action == 'stop':
        run(kube + ['-n', 'payroll', 'scale', 'deployment'] + SERVICES + ['--replicas=0'])
    else:
        # Resume first-time provisioning if a previous build failed after cluster creation.
        backend = subprocess.run(kube + ['-n', 'payroll', 'get', 'deployment/backend',
                                        '--ignore-not-found', '-o', 'name'],
                                 cwd=ROOT, env=env, check=True, capture_output=True, text=True)
        if not backend.stdout.strip():
            context = run(kube + ['config', 'current-context'], capture_output=True, text=True).stdout.strip()
            if context != 'kind-payroll-agent':
                raise ValueError('Automatic provisioning requires the kind-payroll-agent context.')
            provision_kind(kubeconfig, env, 'podman' if engine == 'auto' else engine)
    if action == 'stop' or not use_ray:
        crd = run(kube + ['get','crd','rayservices.ray.io','--ignore-not-found=true','-o','name'], capture_output=True, text=True)
        if crd.stdout.strip():
            run(kube + ['-n', 'agent-models', 'delete', 'rayservice', 'local-slm', '--ignore-not-found=true'])
        run(kube + ['-n', 'agent-models', 'delete', 'deployment', 'model-gateway', '--ignore-not-found=true'])
        if action == 'stop':
            return
    else:
        run(kube + ['get', 'crd', 'rayservices.ray.io'], stdout=subprocess.DEVNULL)
        nodes = json.loads(run(kube + ['get','nodes','-o','json'], capture_output=True, text=True).stdout)
        if not any(int(node.get('status',{}).get('allocatable',{}).get('nvidia.com/gpu',0)) > 0 for node in nodes['items']):
            raise ValueError('Ray Serve requires an NVIDIA GPU advertised by Kubernetes. No model workload was started.')
        run(kube + ['apply', '-f', 'infra/deploy/vllm/namespace.yaml'])
        secret = {'apiVersion':'v1','kind':'Secret','metadata':{'name':'vllm-auth','namespace':'agent-models'},'stringData':{'api-key':key}}
        run(kube + ['apply', '-f', '-'], input=json.dumps(secret).encode())
        run(kube + ['apply', '-f', 'infra/deploy/ray/serving.yaml'])
    sync_model_credentials(kube, env)
    # Key goes over stdin, never a process argument or a printed command.
    patch = {'spec':{'template':{'spec':{'containers':[{'name':'backend','env':[
        {'name':'VLLM_BASE_URL','value':env['VLLM_BASE_URL']}, {'name':'VLLM_API_KEY','value':key}]}]}}}}
    # Keep the key in a Secret and reference it from the pod specification.
    if use_ray:
        secret = {'apiVersion':'v1','kind':'Secret','metadata':{'name':'local-model-auth','namespace':'payroll'},'stringData':{'api-key':key}}
        run(kube + ['apply','-f','-'], input=json.dumps(secret).encode())
        patch['spec']['template']['spec']['containers'][0]['env'][1] = {'name':'VLLM_API_KEY','value':None,'valueFrom':{'secretKeyRef':{'name':'local-model-auth','key':'api-key'}}}
    else:
        patch['spec']['template']['spec']['containers'][0]['env'][1]['valueFrom'] = None
    run(kube + ['-n','payroll','patch','deployment','backend','--type=strategic','--patch',json.dumps(patch)])
    run(kube + ['-n','payroll','scale','deployment'] + SERVICES + ['--replicas=1'])
    for service in SERVICES:
        run(kube + ['-n','payroll','rollout','status','deployment/'+service,'--timeout=180s'])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['up','stop','status'])
    parser.add_argument('--config', type=Path, default=ROOT / 'infra/deploy/platform.json')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--engine', choices=['auto', 'docker', 'podman'], default='auto',
                        help='Compose/build engine; new Kubernetes clusters default to Podman. Existing kubeconfigs are reused.')
    args = parser.parse_args()
    try:
        execute(read_config(args.config), args.action, args.dry_run, args.engine)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Platform command failed: {error}\n')

if __name__ == '__main__':
    main()
