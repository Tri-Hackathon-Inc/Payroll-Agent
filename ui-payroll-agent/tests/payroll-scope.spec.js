import { test, expect } from '@playwright/test'

// Run against the local TriNet UI with TRINET_UI_URL=http://127.0.0.1:5174/trinet/.
// Provider responses and payroll writes are intercepted; reads use the demo stack.
test.skip(!process.env.TRINET_UI_URL, 'Requires the TriNet demo UI and payroll API.')

const payrollUrl = process.env.TRINET_UI_URL || 'http://127.0.0.1:5174/trinet/'
const agents = [
  { id: 'scope-ad', name: 'Scope AD', templateId: 'anomaly-detection', config: { page: 'payrun', questions: ['Which payments need review?'] } },
  { id: 'scope-summary', name: 'Scope summary', templateId: 'summarizer', config: { page: 'payrun', questions: ['Which payments need review?'] } },
  { id: 'scope-incident', name: 'Scope incident', templateId: 'incident-report', config: { page: 'payrun', questions: [] } },
]

async function openPayroll(page) {
  const requests = []
  await page.route('**/agent-studio/graphql', async route => {
    if (route.request().postDataJSON().query.includes('GetServiceAgentRegistry')) {
      await route.fulfill({ json: { data: { getServiceAgentRegistry: agents } } })
    } else await route.continue()
  })
  await page.route('**/webhook/**', async route => {
    const body = route.request().postDataJSON()
    requests.push(body)
    await route.fulfill({ json: { reply: `Review for ${body.context.employeeId || 'all employees'}.`,
      session: { id: body.sessionId || String(requests.length).repeat(64) } } })
  })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  await expect(page.getByRole('button', { name: 'Maya Chen', exact: true })).toBeVisible()
  return requests
}

async function askSuggested(page) {
  const suggested = page.getByRole('button', { name: 'Which payments need review?', exact: true })
  if (await suggested.isVisible()) await suggested.click()
  else {
    await page.getByRole('textbox', { name: /^Ask / }).fill('Which payments need review?')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
  }
  await expect(page.getByLabel('Agent', { exact: true })).toBeEnabled()
}

test('payroll employee selection survives opening, reopening and changing the assistant agent', async ({ page }) => {
  const requests = await openPayroll(page)
  await page.getByRole('button', { name: 'Maya Chen', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await askSuggested(page)
  expect(requests[0].context.employeeId).toBe('E1001')
  await expect(page.getByLabel('Employee scope')).toHaveValue('E1001')
  await expect(page.getByRole('status')).toContainText('Reviewing Maya Chen (E1001) only.')

  await page.getByRole('button', { name: 'Close assistant', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await askSuggested(page)
  expect(requests[1].context.employeeId).toBe('E1001')
  expect(requests[1].sessionId).toBe('1'.repeat(64))

  await page.getByLabel('Agent', { exact: true }).selectOption('scope-summary')
  await askSuggested(page)
  expect(requests[2].context.employeeId).toBe('E1001')
  expect(requests[2].sessionId).toBeUndefined()

  await page.getByLabel('Employee scope').selectOption('E1002')
  await askSuggested(page)
  expect(requests[3].context.employeeId).toBe('E1002')
  expect(requests[3].sessionId).toBeUndefined()
  await expect(page.locator('.tn-copilot-thread')).not.toContainText('Review for E1001.')

  await page.getByRole('button', { name: 'Create incident report with Scope incident' }).click()
  await expect(page.getByLabel('Agent', { exact: true })).toBeEnabled()
  const incident = requests.pop()
  expect(incident.context).toMatchObject({ employeeId: 'E1002', task: 'incident-report' })
  expect(incident.context.handoff.conversation.map(item => item.text).join(' ')).toContain('Review for E1002.')
  expect(incident.context.handoff.conversation.map(item => item.text).join(' ')).not.toContain('Review for E1001.')

  await page.getByLabel('Employee scope').selectOption('')
  await askSuggested(page)
  expect(requests[4].context.employeeId).toBeNull()
  expect(requests[4].sessionId).toBeUndefined()
  await expect(page.getByRole('status')).toContainText('Reviewing all employees')
  await page.getByRole('button', { name: 'Close assistant', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await expect(page.getByLabel('Employee scope')).toHaveValue('')
})

test('saving an employee keeps that employee selected; changing payruns resets scope', async ({ page }) => {
  let run
  await page.route('**/trinet/graphql', async route => {
    const { query } = route.request().postDataJSON()
    if (query.includes('mutation UpdatePayLine')) {
      await route.fulfill({ json: { data: { updatePayLine: { ...run, version: run.version + 1 } } } })
    } else {
      const response = await route.fetch()
      const body = await response.json()
      if (body.data?.payrun) run = body.data.payrun
      await route.fulfill({ response, json: body })
    }
  })
  const requests = await openPayroll(page)
  await page.getByRole('button', { name: 'Maya Chen', exact: true }).click()
  const bonus = page.getByRole('spinbutton', { name: 'Bonus', exact: true })
  await bonus.fill(String(Number(await bonus.inputValue()) + 1))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status')).toContainText("Maya Chen's pay was saved")
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await askSuggested(page)
  expect(requests[0].context.employeeId).toBe('E1001')

  await page.getByRole('button', { name: 'Close assistant', exact: true }).click()
  await page.locator('.tn-back').click()
  // Browser navigation also changes the payrun without reloading the React app.
  await page.evaluate(() => {
    window.history.pushState({}, '', '?domain=payroll-services&payrun=PR-2026-09-A')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await expect(page.getByLabel('Employee scope')).toHaveValue('')
  await askSuggested(page)
  expect(requests[1].context).toMatchObject({ payrunId: 'PR-2026-09-A', employeeId: null })
  expect(requests[1].sessionId).toBeUndefined()
})
