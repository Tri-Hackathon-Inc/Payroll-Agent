import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSchema, parse, validate, printSchema } from 'graphql'
import * as operations from '../src/graphql/operations.js'
import { createMockExecutor } from '../mock/graphqlMock.js'

const require = createRequire(import.meta.url)
const { typeDefs } = require('../../backend/graphql/schema.js')

test('all UI operations use the backend contract and the mock schema matches it', () => {
  const backend = buildSchema(typeDefs)
  const mock = buildSchema(readFileSync(new URL('../graphql/schema.graphql', import.meta.url), 'utf8'))
  assert.equal(printSchema(mock), printSchema(backend))
  for (const query of Object.values(operations)) assert.deepEqual(validate(backend, parse(query)), [])
})

test('mock saves full configuration and isolates businesses', async () => {
  const execute = createMockExecutor()
  const created = await execute({ query: operations.CREATE_AGENT_MUTATION, variables: { input: {
    businessName: 'payroll-services', templateId: 'anomaly-detection', name: 'Review',
    config: { capabilities: { alerts: { enabled: false } } },
  } } })
  assert.equal(created.errors, undefined)
  const agent = created.data.createAgent
  assert.equal(agent.config.capabilities.alerts.enabled, false)
  const updated = await execute({ query: operations.UPDATE_AGENT_MUTATION, variables: { input: {
    id: agent.id, businessName: 'payroll-services', name: 'Updated review', config: { questions: [] },
  } } })
  assert.equal(updated.errors, undefined)
  assert.equal(updated.data.updateAgent.config.capabilities.alerts.enabled, false)
  const other = await execute({ query: operations.BUSINESS_AGENTS_QUERY, variables: { businessName: 'payroll-demo' } })
  assert.deepEqual(other.data.getBusinessAgents, [])
  const badUpdate = await execute({ query: operations.UPDATE_AGENT_MUTATION, variables: { input: {
    id: agent.id, businessName: 'payroll-demo', name: 'Wrong business', config: {},
  } } })
  assert.equal(badUpdate.errors[0].extensions.code, 'NOT_FOUND')
})
