import { pathToFileURL } from 'node:url'

const servicePorts = {
  redis: [6379],
  'vector-db': [5432],
  db: [3306],
  backend: [4000, 50051],
  ui: [5173],
  'trinet-mock': [4100],
  'trinet-ui': [5174],
  'evidence-capture': [4300],
}

const nodePorts = { 4000: 30400, 50051: 30551, 5173: 30573, 4100: 30410, 5174: 30574 }
const volumeSizes = { mysql_data: '5Gi', vector_data: '5Gi', trinet_data: '1Gi', embedding_cache: '5Gi' }
const volumeName = name => name.replaceAll('_', '-')

export function render(compose) {
  const namespace = 'payroll'
  const items = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: namespace } }]
  const metadata = name => ({ name, namespace })
  const claims = new Map()

  for (const [name, service] of Object.entries(compose.services)) {
    if (!servicePorts[name]) throw new Error(`Unsupported service: ${name}`)
    const labels = { app: name }
    const environment = Object.fromEntries(Object.entries(service.environment ?? {})
      .filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
    const data = Object.fromEntries(Object.entries(environment).map(([key, value]) => [key, Buffer.from(value).toString('base64')]))
    items.push({ apiVersion: 'v1', kind: 'Secret', metadata: metadata(`${name}-env`), type: 'Opaque', data })

    const volumes = []
    const volumeMounts = []
    for (const volume of service.volumes ?? []) {
      const claim = volume.type === 'volume' ? volumeName(volume.source)
        : volume.type === 'bind' && volume.target === '/incident-artifacts' ? 'incident-artifacts' : null
      if (!claim) throw new Error(`Unsupported volume on ${name}: ${volume.target}`)
      claims.set(claim, volumeSizes[volume.source] ?? '5Gi')
      volumes.push({ name: claim, persistentVolumeClaim: { claimName: claim } })
      volumeMounts.push({ name: claim, mountPath: volume.target, readOnly: volume.read_only ?? false })
    }

    const container = {
      name,
      image: service.build ? `docker.io/payroll/${name}:local` : service.image,
      imagePullPolicy: service.build ? 'Never' : 'IfNotPresent',
      envFrom: [{ secretRef: { name: `${name}-env` } }],
      ports: servicePorts[name].map(containerPort => ({ containerPort })),
      volumeMounts,
      resources: {
        requests: { cpu: '100m', memory: '128Mi' },
        limits: { memory: ['backend', 'ui', 'evidence-capture'].includes(name) ? '4Gi' : '2Gi' },
      },
    }
    if (service.command) {
      if (!Array.isArray(service.command)) throw new Error(`Expected an array command for ${name}`)
      container.args = service.command
    }
    if (service.healthcheck && !service.healthcheck.disable) {
      const [mode, ...command] = service.healthcheck.test
      if (!['CMD', 'CMD-SHELL'].includes(mode)) throw new Error(`Unsupported healthcheck on ${name}`)
      const exec = { command: mode === 'CMD' ? command : ['sh', '-c', command.join(' ').replaceAll('$$', '$')] }
      container.startupProbe = { exec, periodSeconds: 5, timeoutSeconds: 5, failureThreshold: 120 }
      container.readinessProbe = { exec, periodSeconds: 10, timeoutSeconds: 5, failureThreshold: 3 }
    }

    items.push({
      apiVersion: 'apps/v1', kind: 'Deployment', metadata: metadata(name),
      spec: {
        replicas: 1, strategy: { type: 'Recreate' }, selector: { matchLabels: labels },
        template: { metadata: { labels }, spec: { automountServiceAccountToken: false, containers: [container], volumes } },
      },
    })
    items.push({
      apiVersion: 'v1', kind: 'Service', metadata: metadata(name),
      spec: {
        selector: labels,
        type: servicePorts[name].some(port => nodePorts[port]) ? 'NodePort' : 'ClusterIP',
        ports: servicePorts[name].map(port => ({ name: `port-${port}`, port, targetPort: port,
          ...(nodePorts[port] ? { nodePort: nodePorts[port] } : {}) })),
      },
    })
  }
  for (const [name, size] of claims) {
    items.push({ apiVersion: 'v1', kind: 'PersistentVolumeClaim', metadata: metadata(name),
      spec: { accessModes: ['ReadWriteOnce'], resources: { requests: { storage: size } } } })
  }
  return { apiVersion: 'v1', kind: 'List', items }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  process.stdout.write(JSON.stringify(render(JSON.parse(input))))
}