import { test, expect } from '@playwright/test'
import { assistant, mockPayroll, payrollUrl, openAssistant } from './payrun-fixture.js'

test.skip(!process.env.TRINET_UI_URL, 'Use playwright.runtime.config.js for the host integration.')

test('attached General Query opens automatically and user minimization preserves the draft', async ({ page }) => {
  await mockPayroll(page)
  const requests = []
  await page.route('**/webhook/**', route => { requests.push(route.request().postDataJSON()); return route.fulfill({ json: { reply: 'Answer' } }) })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  const ui = assistant(page)
  await expect(ui.getByRole('textbox', { name: 'Ask General Query' })).toBeVisible()
  const bounds = await page.locator('#tn-assistant').boundingBox()
  expect(bounds.width).toBeLessThanOrEqual(400)
  expect(requests).toHaveLength(0)
  await ui.getByRole('textbox', { name: 'Ask General Query' }).fill('Why did payroll change?')
  await ui.getByRole('button', { name: 'Minimize chat' }).click()
  await expect(page.locator('#tn-assistant')).toBeHidden()
  await page.getByRole('button', { name: /Open Payroll Assistant/ }).click()
  await expect(ui.getByRole('textbox', { name: 'Ask General Query' })).toHaveValue('Why did payroll change?')
  expect(requests).toHaveLength(0)
})

test('chat shows Q and A without question options and reveals the composer on hover or focus', async ({ page }) => {
  await mockPayroll(page)
  const requests = []
  await page.route('**/webhook/**', route => {
    requests.push(route.request().postDataJSON())
    return route.fulfill({ json: { reply: 'Verify the approved bonus for Maya.',
      analysis: { details: 'Hidden detailed evidence' }, retrieval: { sources: [{ id: 'source-1' }] } } })
  })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  const ui = assistant(page)
  await expect(ui.getByRole('button', { name: /All questions|Which payments need review/ })).toHaveCount(0)
  const input = ui.getByRole('textbox', { name: 'Ask General Query' })
  await input.fill('Why did Jev flag this payrun?')
  await ui.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(ui.locator('.tn-copilot-thread')).toContainText('Verify the approved bonus for Maya.')
  await expect(ui.locator('.tn-copilot-author')).toHaveCount(0)
  await expect(ui.locator('.tn-copilot-thread')).not.toContainText('Hidden detailed evidence')
  await expect(ui.getByRole('button', { name: /Create incident|Helpful/ })).toHaveCount(0)
  // Move pointer and keyboard focus outside the frame after reading the answer.
  await page.getByRole('button', { name: /Payroll Assistant/ }).focus()
  await page.mouse.move(1, 1)
  await expect(input).toBeHidden()
  await ui.locator('.tn-copilot-thread').hover()
  await expect(input).toBeVisible()
  await page.mouse.move(1, 1)
  await ui.getByLabel('Payroll assistant', { exact: true }).focus()
  await expect(input).toBeVisible()
  await input.fill('What should I check?')
  await ui.getByRole('button', { name: 'Minimize chat' }).click()
  await openAssistant(page)
  await expect(input).toHaveValue('What should I check?')
  expect(requests).toHaveLength(1)
})

test('runtime discovery failure can be retried without losing employee selection', async ({ page }) => {
  await mockPayroll(page)
  let failed = false
  await page.route('**/ui-templates/manifest.json', async route => {
    if (failed) return route.continue()
    failed = true
    await route.fulfill({ status: 503, body: 'Temporarily unavailable' })
  })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  await page.getByRole('button', { name: 'Maya Chen', exact: true }).click()
  await openAssistant(page)
  await expect(page.getByRole('alert')).toContainText('503')
  await expect(page.getByRole('button', { name: 'Maya Chen', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Retry agent UI' }).click()
  await expect(assistant(page).getByLabel('Employee scope')).toHaveValue('E1001')
})

test('rejects unrelated messages and refreshes saved agents when reopened', async ({ page }) => {
  await mockPayroll(page)
  let deleted = false
  await page.route('**/agent-studio/graphql', async route => {
    if (!deleted || !route.request().postDataJSON().query.includes('GetServiceAgentRegistry')) return route.fallback()
    await route.fulfill({ json: { data: { getServiceAgentRegistry: [] } } })
  })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  await openAssistant(page)
  const ui = assistant(page)
  await expect(ui.getByLabel('Employee scope')).toHaveValue('')
  await page.evaluate(() => {
    const frame = document.querySelector('iframe')
    const instance = new URL(frame.src).searchParams.get('instance')
    window.dispatchEvent(new MessageEvent('message', { origin: 'https://unrelated.example', source: frame.contentWindow,
      data: { protocol: 'agent-ui-v1', instance, type: 'employee-change', employeeId: 'E1001' } }))
    window.dispatchEvent(new MessageEvent('message', { origin: location.origin, source: window,
      data: { protocol: 'agent-ui-v1', instance, type: 'close' } }))
  })
  await expect(page.getByRole('button', { name: /Payroll Assistant/ })).not.toContainText('Maya Chen')
  await expect(ui.getByLabel('Employee scope')).toBeVisible()
  deleted = true
  await ui.getByRole('button', { name: 'Minimize chat' }).click()
  await openAssistant(page)
  await expect(ui.getByText(/No General Query agent is attached to the payrun page yet/)).toBeVisible()
  await expect(ui.getByLabel('Agent', { exact: true })).toHaveCount(0)
})


test('agent connection health turns red on failure and recovers on the next check', async ({ page }) => {
  await mockPayroll(page)
  await page.clock.install()
  let offline = false
  await page.route('**/agent-studio/graphql', route => {
    if (!route.request().postDataJSON().query.includes('query AgentHealth')) return route.fallback()
    if (offline) return route.fulfill({ status: 503, json: { errors: [{ message: 'Unavailable' }] } })
    return route.fulfill({ json: { data: { agentHealth: { scope: 'Connectivity check', items: [{ agentId: 'scope-ad', agentName: 'Scope AD', status: 'live', reason: 'Primary service responded.', checkedAt: new Date().toISOString() }] } } } })
  })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  const health = page.getByLabel('Agent connections')
  await expect(health).toContainText('Scope AD: Live')
  await expect(health.locator('.live')).toHaveCount(1)
  offline = true
  await page.clock.runFor(31000)
  await expect(health).toContainText('Scope AD: Not connected')
  await expect(health.locator('.offline')).toHaveCount(1)
  offline = false
  await page.clock.runFor(31000)
  await expect(health).toContainText('Scope AD: Live')
})
