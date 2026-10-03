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
    if (key === 'anomaly') {
      if (!object(value) || Object.keys(value).some(name => !['profile', 'featureStore', 'enricher', 'detector', 'investigator', 'tools', 'decisionModel'].includes(name))
          || Object.values(value).some(item => typeof item !== 'string') || value.decisionModel && !['jev', 'none'].includes(value.decisionModel)) fail('Invalid anomaly configuration.')
      result[key] = { ...base[key], ...value }
      continue
    }
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
  const snapshotModel = (source, config) => {
    const model = source.modelOptions.find(item => item.id === config.model)
    return model ? { ...model, model_id: model.modelId } : {}
  }
  for (const agent of agents) agent.modelConfig ||= snapshotModel(template(agent.templateId), agent.config)

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
      modelConfig: existing?.config.model === config.model ? existing.modelConfig : snapshotModel(source, config),
      config, createdAt: existing?.createdAt || now, updatedAt: now }
    if (existing) Object.assign(existing, agent)
    else agents.push(agent)
    return agent
  }

  const rootValue = {
    agentHealth: ({ domainName, agentId }) => ({ items: agents.filter(agent => agent.domainName === domainName && (!agentId || agent.id === agentId) && agent.config.service).map(agent => ({ agentId: agent.id, agentName: agent.name, serviceId: agent.config.service, status: 'not_connected', reason: 'Preview mode: no live service health check is available.', checkedAt: new Date().toISOString() })), scope: 'Preview mode; live connectivity is not tested.' }),
    agentPipeline: ({ domainName, agentId, anomalyId }) => {
      domain(domainName)
      const agent = agents.find(item => item.id === agentId && item.domainName === domainName)
      if (!agent) fail('Agent not found in this domain.', 'NOT_FOUND')
      if (anomalyId) fail('Anomaly not found for this agent and domain.', 'NOT_FOUND')
      const anomaly = agent.templateId === 'anomaly-detection' || !!agent.config.anomaly
      const stage = (id, label, status, detail) => ({ id, label, status, detail })
      const model = agent.modelConfig.name || agent.config.model
      return { agentId, agentName: agent.name, kind: anomaly ? 'anomaly' : 'conversation',
        profile: anomaly ? agent.config.anomaly?.profile || 'payroll' : 'conversation', updatedAt: new Date().toISOString(),
        model: { name: model, provider: agent.modelConfig.provider, enabled: true }, components: agent.config.anomaly || {},
        checks: [], check: null, features: { rows: [], total: 0, truncated: false }, audit: [], canReview: false, configurationChanged: false,
        stages: anomaly ? [
          stage('source', 'Source data', 'awaiting_data', 'Mock mode has no saved source checks.'),
          stage('features', 'Generated features', 'awaiting_data', 'Feature values appear after a saved check.'),
          stage('rules', 'Rules & statistics', 'awaiting_data', 'Waiting for generated features.'),
          stage('decision', 'Jev / decision model', 'not_configured', 'No decision-model adapter is configured.'),
          stage('review', 'User Review', 'awaiting_data', 'Select Review on a saved finding to authorize investigation.'),
          stage('llm', 'LLM investigation', 'awaiting_data', `${model} is invoked only after Review.`),
          stage('result', 'Result & feedback', 'awaiting_data', 'Investigation results are retained with the check.'),
        ] : [
          stage('source', 'User question', 'configured', 'A submitted message starts the conversation pipeline.'),
          stage('query', 'Query & evidence', agent.config.pipelines?.query?.enabled === false ? 'disabled' : 'configured', 'Payrun context enables historical retrieval.'),
          stage('llm', 'LLM response', 'configured', model),
          stage('response', 'Response', 'configured', 'Grounded answers validate evidence.'),
        ] }
    },
    chatAgent: ({ input }) => {
      domain(input.domainName)
      const agent = agents.find(item => item.id === input.agentId && item.domainName === input.domainName)
      if (!agent) fail('Agent not found in this domain.', 'NOT_FOUND')
      if (!input.message.trim() || input.message.length > 10000) fail('message must be nonempty text of at most 10000 characters.')
      const history = input.history || []
      if (history.length > 40 || history.length % 2 || history.some((item, index) =>
        item.role !== (index % 2 ? 'assistant' : 'user') || !item.content.trim() || item.content.length > 10000)) fail('Invalid chat history.')
      if (history.reduce((size, item) => size + item.content.length, input.message.length) > 100000) fail('Conversation is too long. Start a new chat.')
      return { agentId: agent.id, modelId: agent.modelConfig.model_id || agent.config.model,
        output: `Demo response (no model inference): ${input.message.trim()}`, demo: true }
    },
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
    // Mock mode has no sign-in: the Studio is open, as without STUDIO_ADMIN_KEY.
    viewer: () => ({ role: 'admin', authMode: 'open', allowedModels: null, allowedTools: null,
      features: ['createAgents', 'testAgents', 'agentTools', 'usage', 'manageAgents', 'tools', 'models', 'evaluation', 'metrics'] }),
    // Mock mode records no answers, so metrics are honestly empty (no sample numbers).
    agentMetrics: ({ domainName, agentId, sinceHours }) => {
      domain(domainName)
      return { window: { sinceHours: sinceHours || null, agentId: agentId || null, rows: 0, truncated: false },
        summary: { questions: 0, conversations: 0, payrunsReviewed: 0, activeAgents: 0, answeredFromData: 0, dataShare: null,
          errors: 0, avgLatencyMs: null, p95LatencyMs: null, up: 0, down: 0, helpfulRate: null },
        business: { findings: { critical: 0, warning: 0, info: 0 }, amountAtRisk: 0, incidentsRaised: 0, manualIncidents: 0,
          realtimeChecks: 0, realtimeIncidents: 0,
          warningsSuggested: 0, topQuestions: [] },
        quality: { modelAnswers: 0, cached: 0, cacheHitRate: null, checked: 0, flagged: 0, checkPassRate: null, errorReasons: [],
          repeatedQuestions: 0, consistent: 0, consistencyRate: null, variedAnswers: [] },
        answerTypes: [], models: [], agents: [], timeline: [], recent: [] }
    },
    rateAnswer: ({ input }) => {
      domain(input.domainName)
      fail('Answer not found in this domain.', 'NOT_FOUND')
    },
    createAgent: ({ input }) => save(input),
    deleteAgent: ({ id, domainName }) => {
      domain(domainName)
      const index = agents.findIndex(agent => agent.id === id && agent.domainName === domainName)
      if (index < 0) fail('Agent not found in this domain.', 'NOT_FOUND')
      agents.splice(index, 1)
      return true
    },
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

const AGENTS_QUERY = 'query ($domainName: String!) { getServiceAgentRegistry(domainName: $domainName) { id name config } }'

// Mirrors describeContext in backend/runtime/execution.py.
const describeContext = context => context?.page
  ? `Invoked from the ${context.page} page${context.payrunId ? ` for payrun ${context.payrunId}` : ''}. ` : ''

// Mock of the Apollo chat webhook: POST <webhookPath>/<domainName>/<agentId> with { question }.
export async function mockWebhook(execute, req, res) {
  const send = (status, body) => { res.statusCode = status; res.end(JSON.stringify(body)) }
  res.setHeader('Content-Type', 'application/json')
  const [domainName, agentId] = req.url.split('?')[0].split('/').filter(Boolean).map(decodeURIComponent)
  if (req.method !== 'POST' || !domainName || !agentId) return send(404, { message: 'Use POST /webhook/<domain>/<agentId>.' })
  let body = ''
  for await (const chunk of req) body += chunk
  let question, context
  try { ({ question, context } = JSON.parse(body || '{}')) } catch { return send(400, { message: 'Request body must be JSON.' }) }
  if (typeof question !== 'string' || !question.trim()) return send(400, { message: 'A question is required.' })
  const result = await execute({ query: AGENTS_QUERY, variables: { domainName } })
  if (result.errors) return send(404, { message: result.errors[0].message })
  const agent = result.data.getServiceAgentRegistry.find(item => item.id === agentId)
  if (!agent) return send(404, { message: `Agent ${agentId} was not found for ${domainName}.` })
  send(200, { agent: { id: agent.id, name: agent.name },
    reply: `${agent.name} received your question: "${question.trim()}". It is configured with model ${agent.config.model} and service ${agent.config.service}. ${describeContext(context)}Agent execution is not active yet, so no answer was generated.` })
}
