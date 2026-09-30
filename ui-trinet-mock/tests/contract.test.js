import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { buildSchema, parse, validate } from 'graphql'
import * as operations from '../src/operations.js'

const require = createRequire(import.meta.url)
const { typeDefs: agentStudioTypeDefs } = require('../../backend/graphql/aistudio.js')
const payrollSchema = buildSchema(readFileSync(new URL('../../backend/trinet_mock/schema.graphql', import.meta.url), 'utf8'))
const agentStudioSchema = buildSchema(agentStudioTypeDefs)

// Each operation must match the backend it is sent to (see src/api.js).
const PAYROLL = ['PAYRUNS_QUERY', 'PAYRUN_QUERY', 'UPDATE_PAY_LINE_MUTATION']
const AGENT_STUDIO = ['DOMAINS_QUERY']

test('every operation validates against its backend schema', () => {
  assert.deepEqual(Object.keys(operations).sort(), [...PAYROLL, ...AGENT_STUDIO].sort())
  for (const name of PAYROLL) assert.deepEqual(validate(payrollSchema, parse(operations[name])), [], name)
  for (const name of AGENT_STUDIO) assert.deepEqual(validate(agentStudioSchema, parse(operations[name])), [], name)
})
