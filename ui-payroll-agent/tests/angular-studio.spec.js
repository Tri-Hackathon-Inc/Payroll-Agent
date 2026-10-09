import { test, expect } from '@playwright/test'
import { basePath } from '../scripts/settings.mjs'
import { CREATE_AGENT_MUTATION } from '../src/graphql/operations.js'
const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')

test('Angular agent editing persists changes and metrics and evaluation remain available', async ({ page, request }) => {
  const name = `Angular edit ${Date.now()}`
  await request.post(`${BASE}graphql`, { data: { query: CREATE_AGENT_MUTATION, variables: { input: {
    domainName: 'payroll-services', templateId: 'general-query', name, config: {},
  } } } })
  await page.goto(BASE)
  const nav = page.getByRole('navigation', { name: 'Agent Studio' })
  await nav.getByRole('button', { name: 'My Agents', exact: true }).click()
  await expect(nav.getByRole('button', { name: 'My Agents', exact: true })).toHaveClass(/active/)
  await expect(nav.getByRole('button', { name: 'Services', exact: true })).not.toHaveClass(/active/)
  await page.locator('.my-agent-row').filter({ hasText: name }).getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Agent name', { exact: true }).fill(`${name} updated`)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.locator('.my-agent-row').filter({ hasText: `${name} updated` })).toBeVisible()
  await nav.getByRole('button', { name: 'Agent Metrics', exact: true }).click()
  await expect(page.getByText('No answers recorded in this period')).toBeVisible()
  await page.getByLabel('Time range').selectOption({ label: 'All time' })
  await expect(page.getByText('No answers recorded in this period')).toBeVisible()
  await nav.getByRole('button', { name: 'Evaluation', exact: true }).click()
  const row = page.locator('li.list-group-item').filter({ hasText: `${name} updated` })
  await row.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(row.getByRole('button', { name: 'Re-run', exact: true })).toBeEnabled()
  await expect(row.locator('.eval-detail').first()).toBeVisible()
})

test('customer permissions hide admin controls and restrict configuration choices', async ({ page }) => {
  await page.route('**/graphql', async route => {
    if (route.request().postDataJSON().query.includes('query Viewer')) return route.fulfill({ json: { data: { viewer: {
      role: 'user', authMode: 'key', features: ['createAgents', 'testAgents', 'agentTools', 'usage'],
      allowedModels: ['llama-3-3-70b'], allowedTools: ['payrun', 'employee-details'],
    } } } })
    return route.continue()
  })
  await page.goto(BASE)
  const nav = page.getByRole('navigation', { name: 'Agent Studio' })
  await expect(nav.getByRole('button')).toHaveText(['Services', 'Tools & APIs', 'My Agents', 'Usage'])
  await page.locator('.service-card').filter({ hasText: 'Payroll' }).click()
  await page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Anomaly Detection', exact: true }) }).getByRole('button', { name: 'Use Template' }).click()
  await expect(page.getByRole('radiogroup', { name: 'Model' }).getByRole('radio')).toHaveCount(1)
  await expect(page.getByLabel('Primary external API').locator('option')).toHaveCount(2)
  await nav.getByRole('button', { name: 'My Agents', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
})
