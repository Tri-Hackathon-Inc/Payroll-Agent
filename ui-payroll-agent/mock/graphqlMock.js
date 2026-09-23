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
  const { businesses, templates, agents } = JSON.parse(readFile('./data.json'))
  const business = name => businesses.find(item => item.name === name) || fail(`Business ${name} not found.`, 'NOT_FOUND')
  const template = id => templates.find(item => item.id === id) || fail(`Template ${id} not found.`, 'NOT_FOUND')

  function save(input, existing) {
    const selectedBusiness = business(input.businessName)
    const source = template(existing?.templateId || input.templateId)
    const config = merge(existing?.config || source.config, input.config)
    if (!input.name.trim() || input.name.trim().length > 150) fail('A name of at most 150 characters is required.')
    if (source.config.domain !== selectedBusiness.domain || config.domain !== selectedBusiness.domain) fail('Agent domain must match its business.')
    for (const key of ['description', 'instructions', 'created_by']) {
      if (typeof config[key] !== 'string' || !config[key].trim()) fail(`${key} is required.`)
    }
    if (!source.modelOptions.some(item => item.id === config.model)) fail('Select an enabled model.')
    if (!Array.isArray(config.attached_services) || !Array.isArray(config.questions)) fail('Services and questions must be arrays.')
    for (const id of [config.service, ...config.attached_services]) {
      if (!source.serviceOptions.some(item => item.id === id)) fail('Select an enabled service in the business domain.')
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
    const agent = { id: existing?.id || randomUUID(), name: input.name.trim(), businessName: selectedBusiness.name,
      templateId: source.id, templateVersion: existing?.templateVersion || source.version,
      config, createdAt: existing?.createdAt || now, updatedAt: now }
    if (existing) Object.assign(existing, agent)
    else agents.push(agent)
    return agent
  }

  const rootValue = {
    getBusinesses: () => businesses,
    getTemplates: () => templates,
    getTemplate: ({ id }) => template(id),
    getBusinessAgents: ({ businessName }) => { business(businessName); return agents.filter(item => item.businessName === businessName) },
    createAgent: ({ input }) => save(input),
    updateAgent: ({ input }) => {
      business(input.businessName)
      const agent = agents.find(item => item.id === input.id && item.businessName === input.businessName)
      if (!agent) fail('Agent not found in this business.', 'NOT_FOUND')
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
