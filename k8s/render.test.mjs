import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { render } from './render.mjs'

const compose = {
  services: {
    backend: {
      build: { target: 'backend' },
      environment: { HF_TOKEN: 'test-secret', MYSQL_HOST: 'db', OMITTED: null, PORT: 4000 },
      volumes: [{ type: 'volume', source: 'embedding_cache', target: '/models' },
        { type: 'bind', source: '/repo/.local-data/incidents', target: '/incident-artifacts' }],
      healthcheck: { test: ['CMD', 'node', '-e', 'process.exit(0)'] },
    },
    db: {
      image: 'mysql:8.4',
      volumes: [{ type: 'volume', source: 'mysql_data', target: '/var/lib/mysql' }],
      healthcheck: { test: ['CMD-SHELL', 'MYSQL_PWD=$$MYSQL_PASSWORD mysql -u $$MYSQL_USER'] },
    },
    redis: { image: 'redis:8-alpine', command: ['redis-server', '--save', '', '--appendonly', 'no'] },
  },
}
const find = (resources, kind, name) => resources.items.find(item => item.kind === kind && item.metadata.name === name)

test('keeps credentials in Secrets and retains service DNS and image targets', () => {
  const resources = render(compose)
  const backend = find(resources, 'Deployment', 'backend')
  const container = backend.spec.template.spec.containers[0]
  assert.equal(container.image, 'docker.io/payroll/backend:local')
  assert.equal(container.imagePullPolicy, 'Never')
  assert.deepEqual(container.envFrom, [{ secretRef: { name: 'backend-env' } }])
  assert.equal(JSON.stringify(backend).includes('test-secret'), false)
  const secret = find(resources, 'Secret', 'backend-env')
  assert.equal(secret.stringData, undefined)
  assert.deepEqual(Object.fromEntries(Object.entries(secret.data).map(([key, value]) => [key, Buffer.from(value, 'base64').toString()])),
    { HF_TOKEN: 'test-secret', MYSQL_HOST: 'db', PORT: '4000' })
  assert.deepEqual(find(resources, 'Service', 'backend').spec.ports.map(port => port.nodePort), [30400, 30551])
  assert.equal(find(resources, 'Service', 'db').spec.type, 'ClusterIP')
  assert.equal(backend.spec.template.spec.automountServiceAccountToken, false)
})

test('creates persistent claims, including incident artifacts, with single writer deployments', () => {
  const resources = render(compose)
  assert.equal(find(resources, 'PersistentVolumeClaim', 'mysql-data').spec.resources.requests.storage, '5Gi')
  assert.ok(find(resources, 'PersistentVolumeClaim', 'incident-artifacts'))
  const backend = find(resources, 'Deployment', 'backend')
  assert.equal(backend.spec.replicas, 1)
  assert.equal(backend.spec.strategy.type, 'Recreate')
  assert.equal(backend.spec.template.spec.containers[0].volumeMounts[1].mountPath, '/incident-artifacts')
})

test('translates healthchecks and preserves image entrypoints for Compose commands', () => {
  const resources = render(compose)
  const database = find(resources, 'Deployment', 'db').spec.template.spec.containers[0]
  assert.deepEqual(database.startupProbe.exec.command,
    ['sh', '-c', 'MYSQL_PWD=$MYSQL_PASSWORD mysql -u $MYSQL_USER'])
  assert.deepEqual(database.readinessProbe.exec, database.startupProbe.exec)
  const redis = find(resources, 'Deployment', 'redis').spec.template.spec.containers[0]
  assert.deepEqual(redis.args, compose.services.redis.command)
  assert.equal(redis.command, undefined)
})

test('rejects unsupported services and host bind mounts instead of silently losing data', () => {
  assert.throws(() => render({ services: { unknown: {} } }), /Unsupported service/)
  assert.throws(() => render({ services: { backend: { volumes: [{ type: 'bind', target: '/unknown' }] } } }), /Unsupported volume/)
})

test('credential changes update the server-side apply data field', () => {
  const first = find(render(compose), 'Secret', 'backend-env')
  const changed = { services: { backend: { ...compose.services.backend, environment: { HF_TOKEN: 'changed-secret' } } } }
  const second = find(render(changed), 'Secret', 'backend-env')
  assert.notEqual(first.data.HF_TOKEN, second.data.HF_TOKEN)
  assert.equal(second.data.MYSQL_HOST, undefined)
})

test('launcher help is offline and cluster deletion requires explicit data-loss confirmation', () => {
  const script = new URL('./local.sh', import.meta.url).pathname
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8' })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Usage:/)
  const deletion = spawnSync('bash', [script, 'delete'], { encoding: 'utf8' })
  assert.equal(deletion.status, 1)
  assert.match(deletion.stderr, /--confirm-data-loss/)
})

for (const provider of ['docker', 'podman']) {
  test(`launcher builds qualified images and uses the ${provider} loading path`, () => {
    const directory = mkdtempSync(join(tmpdir(), 'payroll-launcher-test-'))
    try {
      const log = join(directory, 'commands.log')
      const stub = `#!/bin/sh
printf '%s %s\\n' "$(basename "$0")" "$*" >> "$COMMAND_LOG"
case "$(basename "$0") $*" in
  'kind get clusters') printf 'payroll-local\\n' ;;
  'docker compose '*config*) printf '{"services":{}}' ;;
  'kind load image-archive '*) test -f "$3" ;;
esac
`
      for (const executable of ['docker', 'podman', 'kind', 'kubectl']) {
        const path = join(directory, executable)
        writeFileSync(path, stub)
        chmodSync(path, 0o755)
      }
      const result = spawnSync('bash', [new URL('./local.sh', import.meta.url).pathname, 'up'], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, COMMAND_LOG: log, KIND_EXPERIMENTAL_PROVIDER: provider },
      })
      assert.equal(result.status, 0, result.stderr)
      const commands = readFileSync(log, 'utf8')
      assert.match(commands, new RegExp(`${provider} build .*--target backend -t docker.io/payroll/backend:local`))
      assert.match(commands, /kubectl --context kind-payroll-local apply --server-side/)
      if (provider === 'podman') {
        assert.match(commands, /podman save --format docker-archive/)
        assert.match(commands, /kind load image-archive/)
        assert.doesNotMatch(commands, /kind load docker-image/)
      } else {
        assert.match(commands, /kind load docker-image docker.io\/payroll\/backend:local/)
        assert.doesNotMatch(commands, /podman save/)
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
}