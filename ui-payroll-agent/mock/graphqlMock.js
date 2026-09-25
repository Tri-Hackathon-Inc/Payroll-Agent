import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { buildSchema, graphql, GraphQLError } from 'graphql'

const readFile = path => fs.readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
const fail = (message, code = 'BAD_USER_INPUT') => { throw new GraphQLError(message, { extensions: { code } }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function merge(base, override) {
  if (!object(override)) fail('config must be an object.')
  const result = structuredClone(base)
  for (const [key, value] of Object.entries(override)) {
    if (!Object.hasOwn(base, key)) fail(`Unknown configuration property: ${key}`)
    result[key] = object(value) && object(base[key]) ? merge(base[key], value) : value
  }
  return result
}

export function createMockExecutor() {
  const schema = buildSchema(readFile('../graphql/schema.graphql'))
  const { domains, templates, agents } = JSON.parse(readFile('./data.json'))
  const domain = name => domains.find(item => item.name === name) || fail(`Domain ${name} not found.`, 'NOT_FOUND')
  const template = id => templates.find(item => item.id === id) || fail(`Template ${id} not found.`, 'NOT_FOUND')

  function save(input, existing) {
    const selectedDomain = domain(input.domainName)
    const source = template(existing?.templateId || input.templateId)
    const config = merge(existing?.config || source.config, input.config)
    if (!input.name.trim() || input.name.trim().length > 150) fail('A name of at most 150 characters is required.')
    if (source.config.domain !== selectedDomain.domain || config.domain !== selectedDomain.domain) fail('Agent domain must match its domain.')
    for (const key of ['description', 'instructions', 'created_by']) {
      if (typeof config[key] !== 'string' || !config[key].trim()) fail(`${key} is required.`)
    }
    if (!source.modelOptions.some(item => item.id === config.model)) fail('Select an enabled model.')
    if (!Array.isArray(config.attached_services) || !Array.isArray(config.questions)) fail('Services and questions must be arrays.')
    for (const id of [config.service, ...config.attached_services]) {
      if (!source.serviceOptions.some(item => item.id === id)) fail('Select an enabled service in the domain category.')
    }
    const alerts = config.capabilities?.alerts
    const webhooks = config.capabilities?.webhooks
    if (typeof alerts?.enabled !== 'boolean' || !['info', 'warning', 'critical'].includes(alerts.severity)) fail('Invalid alert configuration.')
    if (typeof webhooks?.enabled !== 'boolean' || typeof webhooks.url !== 'string') fail('Invalid webhook configuration.')
    if (webhooks.enabled || webhooks.url) {
      try { if (new URL(webhooks.url).protocol !== 'https:') fail('Webhook URL must use HTTPS.') }
      catch { fail('Webhook URL must use HTTPS.') }
    }
    const now = new Date().toISOString()
    const agent = { id: existing?.id || randomUUID(), name: input.name.trim(), domainName: selectedDomain.name,
      templateId: source.id, templateVersion: existing?.templateVersion || source.version,
      config, createdAt: existing?.createdAt || now, updatedAt: now }
    if (existing) Object.assign(existing, agent)
    else agents.push(agent)
    return agent
  }

  const rootValue = {
    listDomains: () => domains,
    listTemplates: ({ serviceName }) => {
      if (!serviceName.trim()) fail('service_name is required.')
      if (!templates.some(item => item.serviceOptions.some(service => service.id === serviceName))) fail(`Service ${serviceName} not found.`, 'NOT_FOUND')
      return templates.filter(item => item.config.service === serviceName)
    },
    getTemplate: ({ id }) => template(id),
    getDomainAgentsTemplates: ({ domainName }) => templates.filter(item => item.config.domain === domain(domainName).domain),
    getServiceAgentRegistry: ({ serviceName, domainName }) => {
      if (domainName) domain(domainName)
      if (serviceName && !templates.some(item => item.serviceOptions.some(service => service.id === serviceName))) fail(`Service ${serviceName} not found.`, 'NOT_FOUND')
      return agents.filter(item => (!domainName || item.domainName === domainName) && (!serviceName || item.config.service === serviceName))
    },
    createAgent: ({ input }) => save(input),
    updateAgent: ({ input }) => {
      domain(input.domainName)
      const agent = agents.find(item => item.id === input.id && item.domainName === input.domainName)
      if (!agent) fail('Agent not found in this domain.', 'NOT_FOUND')
      return save(input, agent)
    },
  }
  return request => graphql({ schema, rootValue, source: request.query,
    variableValues: request.variables, operationName: request.operationName })
}

export function graphqlMock() {
  const execute = createMockExecutor()
  return {
    name: 'graphql-mock',
    configureServer(server) {
      server.middlewares.use('/graphql', async (req, res) => {
        res.setHeader('Content-Type', 'application/json')
        try {
          let body = ''
          for await (const chunk of req) body += chunk
          res.end(JSON.stringify(await execute(JSON.parse(body))))
        } catch {
          res.statusCode = 400
          res.end(JSON.stringify({ errors: [{ message: 'Invalid GraphQL request.' }] }))
        }
      })
    },
  }
}
