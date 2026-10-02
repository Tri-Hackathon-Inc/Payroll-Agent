import { test, expect } from '@playwright/test'
import { basePath } from '../scripts/settings.mjs'
import { CREATE_AGENT_MUTATION } from '../src/graphql/operations.js'

const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')
const caseId = 'a'.repeat(64), previousId = 'b'.repeat(64)

async function createAgent(page, templateId = 'anomaly-detection') {
  const name = `Pipeline ${Date.now()}-${Math.random().toString(16).slice(2, 6)}`
  const response = await page.request.post(`${BASE}graphql`, { data: { query: CREATE_AGENT_MUTATION,
    variables: { input: { domainName: 'payroll-services', templateId, name, config: {} } } } })
  const body = await response.json()
  expect(body.errors).toBeUndefined()
  return body.data.createAgent
}

async function openPipeline(page, agent) {
  await page.goto(BASE)
  await page.getByRole('navigation', { name: 'Agent Studio' }).getByRole('button', { name: 'My Agents', exact: true }).click()
  await page.locator('.my-agent-row').filter({ hasText: agent.name }).getByRole('button', { name: 'Model pipeline', exact: true }).click()
  await expect(page.getByRole('tab', { name: 'Model pipeline' })).toHaveAttribute('aria-selected', 'true')
}

function pipeline(agent, { completed = false, previous = false } = {}) {
  const check = { id: previous ? previousId : caseId, entityId: previous ? 'leave-3' : 'leave-4', entityType: 'leave-request',
    tenant: 'company-1', version: 1, decision: previous ? 'NORMAL' : 'REVIEW', createdAt: '2026-09-04T12:00:00Z',
    reviewStatus: previous ? 'not_required' : completed ? 'completed' : 'pending', summary: 'Review unusual leave hours.',
    investigation: completed && !previous ? { summary: 'Leave hours exceed the recorded historical baseline.', modelStatus: 'completed', findings: [] } : null }
  const stage = (id, label, status, detail) => ({ id, label, status, detail })
  return { agentId: agent.id, agentName: agent.name, kind: 'anomaly', profile: 'records', updatedAt: new Date().toISOString(),
    model: { name: 'Selected investigation model', provider: 'demo', enabled: true }, components: {},
    check, checks: [{ ...check, id: caseId, entityId: 'leave-4' }, { ...check, id: previousId, entityId: 'leave-3', decision: 'NORMAL' }],
    canReview: !completed && !previous, configurationChanged: false,
    features: { rows: [{ name: 'leaveHours', scope: { employeeId: 'E1', leaveType: 'vacation' }, current: previous ? 8 : 30,
      baseline: 8, baselineKind: 'Mean', unit: 'hours', historyCount: 3, details: { variance: 1, std: 1, p95: 9 } }], total: 1, truncated: false },
    audit: completed ? [{ action: 'REVIEW_REQUESTED', createdAt: '2026-09-04T12:01:00Z' }, { action: 'INVESTIGATION_COMPLETED', createdAt: '2026-09-04T12:01:05Z' }] : [],
    stages: [stage('source', 'Source data', 'completed', `${check.entityId} · version 1`), stage('features', 'Generated features', 'completed', 'Rolling features'),
      stage('rules', 'Rules & statistics', 'completed', check.decision), stage('decision', 'Jev / decision model', 'not_configured', 'Rules and statistics supply the decision.'),
      stage('review', 'User Review', previous ? 'not_required' : completed ? 'completed' : 'waiting', 'Select Review to authorize investigation.'),
      stage('llm', 'LLM investigation', previous ? 'not_required' : completed ? 'completed' : 'waiting', 'Selected investigation model'),
      stage('result', 'Result & feedback', completed || previous ? 'completed' : 'waiting', check.summary)] }
}

test('pipeline uses actual feature values and invokes Review only on an explicit click', async ({ page }) => {
  const agent = await createAgent(page)
  let completed = false, reviewCalls = 0
  const queries = []
  await page.route('**/graphql', async route => {
    const request = route.request().postDataJSON()
    if (!request.query.includes('query AgentPipeline')) return route.continue()
    queries.push(request.variables)
    await route.fulfill({ json: { data: { agentPipeline: pipeline(agent, { completed, previous: request.variables.anomalyId === previousId }) } } })
  })
  await page.route('**/anomalies/review', async route => {
    reviewCalls++
    expect(route.request().postDataJSON()).toEqual({ domainName: 'payroll-services', agentId: agent.id, anomalyId: caseId, expectedVersion: 1, action: 'REVIEW' })
    completed = true
    await route.fulfill({ json: { anomaly: pipeline(agent, { completed }).check } })
  })
  await openPipeline(page, agent)
  await expect(page.locator('[data-stage="llm"]')).toHaveAttribute('data-status', 'waiting')
  await expect(page.locator('[data-stage="decision"]')).toContainText('Not configured')
  const table = page.getByRole('table', { name: 'Generated feature values and historical baselines' })
  await expect(table).toContainText('leaveHours')
  await expect(table).toContainText('30 hours')
  await expect(table).toContainText('p95: 9')
  await page.getByRole('button', { name: 'Explore Generated features', exact: true }).click()
  await expect(page.locator('#pipeline-stage-detail')).toContainText('Rolling features')
  await expect(page.getByRole('button', { name: 'Explore Generated features', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect.poll(() => queries.length).toBe(2)
  expect(reviewCalls).toBe(0)
  await page.screenshot({ path: 'test-results/model-pipeline-desktop.png', fullPage: true })
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.locator('[data-stage="llm"]')).toHaveAttribute('data-status', 'completed')
  await expect(page.getByRole('region', { name: 'Review and investigation' })).toContainText('Leave hours exceed the recorded historical baseline.')
  expect(reviewCalls).toBe(1)
  expect(queries.at(-1).anomalyId).toBe(caseId)
  await page.getByLabel('Saved check').selectOption(previousId)
  await expect(page.locator('[data-stage="llm"]')).toHaveAttribute('data-status', 'not_required')
  await expect(table).toContainText('8 hours')
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: 'test-results/model-pipeline-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
})

test('empty anomaly and conversation pipelines reflect the selected saved agent', async ({ page }) => {
  const agent = await createAgent(page)
  await openPipeline(page, agent)
  await expect(page.getByText('No saved checks yet', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await page.getByRole('tab', { name: 'Chat with agent' }).click()
  await expect(page.getByRole('heading', { name: `Chat with ${agent.name}` })).toBeVisible()
  await page.getByRole('tab', { name: 'Model pipeline' }).click()
  await expect(page.getByText('No saved checks yet', { exact: true })).toBeVisible()
  const conversation = await createAgent(page, 'general-query')
  await openPipeline(page, conversation)
  await expect(page.getByText('This agent uses a conversation pipeline.', { exact: false })).toBeVisible()
  await expect(page.locator('[data-stage="decision"]')).toHaveCount(0)
})

test('decision model selection is saved separately from the investigation model', async ({ page }) => {
  const agent = await createAgent(page)
  await page.goto(BASE)
  const navigation = page.getByRole('navigation', { name: 'Agent Studio' })
  await navigation.getByRole('button', { name: 'My Agents', exact: true }).click()
  const row = page.locator('.my-agent-row').filter({ hasText: agent.name })
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByLabel('Decision model', { exact: true })).toHaveValue('jev')
  await page.getByLabel('Decision model', { exact: true }).selectOption('none')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(row).toBeVisible()
  await row.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(page.getByLabel('Decision model', { exact: true })).toHaveValue('none')
})

test('Jev setup failures and actual returned probabilities are visible', async ({ page }) => {
  const agent = await createAgent(page)
  let hasResult = false
  await page.route('**/graphql', async route => {
    if (!route.request().postDataJSON().query.includes('query AgentPipeline')) return route.continue()
    const flow = pipeline(agent)
    const decision = flow.stages.find(stage => stage.id === 'decision')
    if (hasResult) {
      decision.status = 'completed'
      flow.decisionModelSetup = { status: 'ready', reason: 'Ready' }
      flow.decisionModel = { status: 'completed', model: 'jev-1.13.0', decision: 'REVIEW', score: 0.95, confidence: 0.9,
        probabilities: { NORMAL: 0.05, REVIEW: 0.9, CRITICAL: 0.05 } }
    } else {
      decision.status = 'missing_credentials'
      decision.detail = 'Jev requires a TypeSafe API key.'
      flow.decisionModelSetup = { status: 'missing_credentials', reason: 'Configure TYPESAFE_API_KEY on the backend.' }
    }
    await route.fulfill({ json: { data: { agentPipeline: flow } } })
  })
  await openPipeline(page, agent)
  await expect(page.locator('[data-stage="decision"]')).toContainText('API key required')
  await expect(page.getByRole('status')).toContainText('TYPESAFE_API_KEY')
  hasResult = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  const result = page.getByRole('region', { name: 'Decision model result' })
  await expect(result).toContainText('jev-1.13.0 selected REVIEW')
  await expect(result).toContainText('Review probability0.95')
  await expect(page.locator('[data-stage="llm"]')).toHaveAttribute('data-status', 'waiting')
})

test('refresh errors preserve loaded evidence and failed Review can be retried', async ({ page }) => {
  const agent = await createAgent(page)
  let failQuery = false
  await page.route('**/graphql', async route => {
    if (!route.request().postDataJSON().query.includes('query AgentPipeline')) return route.continue()
    await route.fulfill({ json: failQuery ? { errors: [{ message: 'Pipeline temporarily unavailable.' }] } : { data: { agentPipeline: pipeline(agent) } } })
  })
  await page.route('**/anomalies/review', route => route.fulfill({ status: 409, json: { message: 'Source data changed after this check.' } }))
  await openPipeline(page, agent)
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Source data changed')
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeEnabled()
  failQuery = true
  await page.getByRole('button', { name: 'Refresh', exact: true }).click()
  await expect(page.getByText('Showing the last loaded check.', { exact: true })).toBeVisible()
  await expect(page.getByRole('table')).toContainText('leaveHours')
})
