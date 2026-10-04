"""Config-driven startup. No cluster creation, data migration or volume deletion."""
import argparse
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess

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

def plan(config, action):
    target = 'Kind' if config['kubernetes']['enabled'] else 'Docker Compose'
    model = 'enabled' if config['rayServe']['enabled'] else 'disabled (no model download)'
    return f'{action}: {target}; Ray Serve: {model}'

def check_cluster(kube):
    """Fail promptly with recovery steps before changing any cluster workloads."""
    message = ('The Kubernetes API is not ready. Check Docker Desktop is running, then '
               'check the existing Kind node with: docker ps -a --filter name=payroll-agent-control-plane. '
               'If that container is stopped, run: docker start payroll-agent-control-plane. '
               'Do not recreate or delete the cluster to fix a connection error; it contains platform data.')
    try:
        result = subprocess.run(kube + ['--request-timeout=10s', 'get', '--raw=/readyz'],
                                cwd=ROOT, capture_output=True, text=True, timeout=15)
    except subprocess.TimeoutExpired:
        raise ValueError(message) from None
    if result.returncode != 0 or result.stdout.strip() != 'ok':
        raise ValueError(message)

def execute(config, action, dry_run=False):
    print(plan(config, action), flush=True)
    if dry_run:
        return
    use_kube = config['kubernetes']['enabled']
    use_ray = config['rayServe']['enabled']
    # Fail before any model pull or workload change.
    if action == 'up' and use_ray:
        if shutil.disk_usage(ROOT).free < 35 * 1024**3:
            raise ValueError('Ray Serve startup requires at least 35 GiB free. Model download was not started.')
    env = os.environ.copy()
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
        command = ['docker', 'compose', '-f', 'infra/docker/docker-compose.yaml', '-f', 'infra/docker/docker-compose.ray.yaml']
        for path in ('.env', 'backend/.env'):
            if (ROOT / path).exists():
                command += ['--env-file', path]
        # Always explicitly select a profile; ambient COMPOSE_PROFILES cannot enable models.
        env.pop('COMPOSE_PROFILES', None)
        if action == 'status':
            run(command + ['--profile', 'local-model', 'ps', '-a'])
        elif action == 'stop':
            run(command + ['--profile', 'local-model', 'stop'])
        else:
            if not use_ray:
                run(command + ['--profile', 'local-model', 'stop', 'model-gateway', 'ray-serve'])
            run(command + (['--profile', 'local-model'] if use_ray else []) + ['up', '-d', '--wait'])
        return
    kubeconfig = ROOT / config['kubernetes']['kubeconfig']
    if not kubeconfig.is_file():
        raise ValueError('Kind is not provisioned. Follow the first-time setup in README; startup never creates a cluster.')
    kube = ['kubectl', '--kubeconfig', str(kubeconfig)]
    check_cluster(kube)
    if action == 'status':
        run(kube + ['get', 'pods', '-A'])
        return
    if action == 'stop':
        run(kube + ['-n', 'payroll', 'scale', 'deployment'] + SERVICES + ['--replicas=0'])
    else:
        # Require existing migrated/provisioned storage; never silently seed a new database.
        run(kube + ['-n', 'payroll', 'get', 'deployment/backend'], stdout=subprocess.DEVNULL)
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
    args = parser.parse_args()
    try:
        execute(read_config(args.config), args.action, args.dry_run)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Platform command failed: {error}\n')

if __name__ == '__main__':
    main()
