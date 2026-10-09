import { readFileSync } from 'node:fs'

const fixture = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/payrun-PR-2026-09-B.json', import.meta.url), 'utf8')).payrun
export const payrollUrl = process.env.TRINET_UI_URL || 'http://127.0.0.1:5184/trinet/'
export const agents = [
  { id: 'scope-query', name: 'General Query', templateId: 'general-query', config: { page: 'payrun', questions: ['Which payments need review?'] } },
  { id: 'scope-summary', name: 'Another General Query', templateId: 'general-query', config: { page: 'payrun', questions: ['Which payments need review?'] } },
  { id: 'scope-ad', name: 'Scope AD', templateId: 'anomaly-detection', config: { page: 'payrun', questions: ['Which payments need review?'] } },
  { id: 'scope-incident', name: 'Scope incident', templateId: 'incident-report', config: { page: 'payrun', questions: [] } },
]
export const assistant = page => page.frameLocator('iframe[title="Payroll Assistant"]')
export async function openAssistant(page) {
  const drawer = page.getByRole('complementary', { name: 'Edit employee pay' })
  // Chat remains available alongside the employee editor.
  if (await drawer.isVisible()) {
    const open = drawer.getByRole('button', { name: 'Open employee chat', exact: true })
    if (await open.isVisible()) await open.click()
    return
  }
  const toggle = page.getByRole('button', { name: /Payroll Assistant/ })
  await toggle.waitFor({ state: 'visible' })
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click()
}

export async function mockPayroll(page) {
  let run = { ...structuredClone(fixture), lines: fixture.lines.map((line, i) => ({ ...line, lineId: `L${i}` })) }
  await page.route('https://fonts.googleapis.com/**', route => route.abort())
  await page.route('**/events/stream?*', route => route.fulfill({ contentType: 'text/event-stream', body: '' }))
  await page.route('**/trinet/graphql', async route => {
    const { query, variables } = route.request().postDataJSON()
    if (query.includes('mutation UpdatePayLine')) {
      run = { ...run, version: run.version + 1 }
      await route.fulfill({ json: { data: { updatePayLine: run } } })
    } else await route.fulfill({ json: { data: query.includes('query Payruns') ? { payruns: [run] } : { payrun: { ...run, id: variables.id } } } })
  })
  await page.route('**/agent-studio/graphql', async route => {
    const { query } = route.request().postDataJSON()
    const data = query.includes('AgentHealth') ? { agentHealth: { items: agents.map(agent => ({ agentId: agent.id, agentName: agent.name, templateId: agent.templateId, status: 'live', checkedAt: new Date().toISOString() })) } }
      : query.includes('GetServiceAgentRegistry') ? { getServiceAgentRegistry: agents }
      : query.includes('RateAnswer') ? { rateAnswer: true }
      : { listDomains: [{ name: 'payroll-services', label: 'Payroll Services', domain: 'Payroll' }] }
    await route.fulfill({ json: { data } })
  })
}
