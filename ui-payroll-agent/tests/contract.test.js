import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSchema, parse, validate, printSchema } from 'graphql'
import * as operations from '../src/graphql/operations.js'
import { createMockExecutor } from '../mock/graphqlMock.js'

const require = createRequire(import.meta.url)
const { typeDefs, resolvers } = require('../../backend/graphql/aistudio.js')

test('chat forwards agent, domain, message and history to gRPC', async () => {
  const history = [{ role: 'user', content: 'Hello' }, { role: 'assistant', content: 'Hi' }]
  const reply = await resolvers.Mutation.chatAgent(null, { input: { agentId: 'agent', domainName: 'payroll-services', message: 'Next', history } }, {
    context: {}, dataSources: { grpc: { call: async (...args) => {
      assert.equal(args[3], 'ChatAgent')
      assert.deepEqual(args[4], { agent_id: 'agent', domain_name: 'payroll-services', message: 'Next', history })
      return { agent_id: 'agent', output: 'Answer' }
    } } },
  })
  assert.equal(reply.output, 'Answer')
})

test('mock chat uses a saved agent and rejects another domain', async () => {
  const execute = createMockExecutor()
  const created = await execute({ query: operations.CREATE_AGENT_MUTATION, variables: { input: {
    domainName: 'payroll-services', templateId: 'anomaly-detection', name: 'Chat test', config: {},
  } } })
  assert.equal(created.errors, undefined)
  assert.ok(created.data.createAgent.modelConfig.name)
  const input = { agentId: created.data.createAgent.id, domainName: 'payroll-services', message: 'Hello' }
  const result = await execute({ query: operations.CHAT_AGENT_MUTATION, variables: { input } })
  assert.equal(result.errors, undefined)
  assert.equal(result.data.chatAgent.demo, true)
  assert.match(result.data.chatAgent.output, /no model inference/)
  const wrong = await execute({ query: operations.CHAT_AGENT_MUTATION, variables: { input: { ...input, domainName: 'payroll-demo' } } })
  assert.equal(wrong.errors[0].extensions.code, 'NOT_FOUND')
})

test('listTemplates requires a service and filters templates by primary service', async () => {
  const execute = createMockExecutor()
  const query = 'query ($service: String!) { listTemplates(serviceName: $service) { id config } }'
  const result = await execute({ query, variables: { service: 'payrun' } })
  assert.equal(result.errors, undefined)
  assert.ok(result.data.listTemplates.length > 0)
  assert.ok(result.data.listTemplates.every(item => item.config.service === 'payrun'))
  const empty = await execute({ query, variables: { service: 'payrun-history' } })
  assert.deepEqual(empty.data.listTemplates, [])
  for (const [service, code] of [['missing', 'NOT_FOUND'], ['', 'BAD_USER_INPUT']]) {
    const invalid = await execute({ query, variables: { service } })
    assert.equal(invalid.errors[0].extensions.code, code)
  }
  assert.ok((await execute({ query: '{ listTemplates { id } }' })).errors)
})

test('listTemplates forwards serviceName to gRPC', async () => {
  const templates = [{ id: 'example' }]
  const result = await resolvers.Query.listTemplates(null, { serviceName: 'payrun' }, {
    context: {},
    dataSources: { grpc: { call: async (...args) => {
      assert.equal(args[3], 'ListTemplates')
      assert.deepEqual(args[4], { service_name: 'payrun' })
      return { templates }
    } } },
  })
  assert.deepEqual(result, templates)
})

test('all UI operations use the backend contract and the mock schema matches it', () => {
  const backend = buildSchema(typeDefs)
  const mock = buildSchema(readFileSync(new URL('../graphql/schema.graphql', import.meta.url), 'utf8'))
  assert.equal(printSchema(mock), printSchema(backend))
  for (const query of Object.values(operations)) assert.deepEqual(validate(backend, parse(query)), [])
})

test('mock saves full configuration and isolates domains', async () => {
  const execute = createMockExecutor()
  const created = await execute({ query: operations.CREATE_AGENT_MUTATION, variables: { input: {
    domainName: 'payroll-services', templateId: 'anomaly-detection', name: 'Review',
    config: { capabilities: { alerts: { enabled: false } } },
  } } })
  assert.equal(created.errors, undefined)
  const agent = created.data.createAgent
  assert.equal(agent.config.capabilities.alerts.enabled, false)
  const updated = await execute({ query: operations.UPDATE_AGENT_MUTATION, variables: { input: {
    id: agent.id, domainName: 'payroll-services', name: 'Updated review', config: { questions: [] },
  } } })
  assert.equal(updated.errors, undefined)
  assert.equal(updated.data.updateAgent.config.capabilities.alerts.enabled, false)
  const other = await execute({ query: operations.SERVICE_AGENT_REGISTRY_QUERY, variables: { domainName: 'payroll-demo' } })
  assert.deepEqual(other.data.getServiceAgentRegistry, [])
  const badUpdate = await execute({ query: operations.UPDATE_AGENT_MUTATION, variables: { input: {
    id: agent.id, domainName: 'payroll-demo', name: 'Wrong domain', config: {},
  } } })
  assert.equal(badUpdate.errors[0].extensions.code, 'NOT_FOUND')
})

test('domain templates and service registry expose distinct collections', async () => {
  const execute = createMockExecutor()
  const templates = await execute({ query: operations.DOMAIN_TEMPLATES_QUERY, variables: { domainName: 'payroll-services' } })
  assert.equal(templates.errors, undefined)
  assert.ok(templates.data.getDomainAgentsTemplates.some(item => item.id === 'anomaly-detection'))
  const created = await execute({ query: operations.CREATE_AGENT_MUTATION, variables: { input: {
    domainName: 'payroll-services', templateId: 'anomaly-detection', name: 'Registry test', config: { service: 'diagnostics' },
  } } })
  assert.equal(created.errors, undefined)
  const registry = await execute({ query: operations.SERVICE_AGENT_REGISTRY_QUERY, variables: { serviceName: 'diagnostics', domainName: 'payroll-services' } })
  assert.equal(registry.errors, undefined)
  assert.ok(registry.data.getServiceAgentRegistry.some(item => item.id === created.data.createAgent.id))
  const missing = await execute({ query: operations.SERVICE_AGENT_REGISTRY_QUERY, variables: { serviceName: 'missing' } })
  assert.equal(missing.errors[0].extensions.code, 'NOT_FOUND')
})
