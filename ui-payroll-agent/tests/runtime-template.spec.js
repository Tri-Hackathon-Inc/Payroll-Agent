import { test, expect } from '@playwright/test'
import { assistant, mockPayroll, payrollUrl } from './payrun-fixture.js'

test.skip(!process.env.TRINET_UI_URL, 'Use playwright.runtime.config.js for the host integration.')

test('loads the published Angular template and preserves feedback, question library and incident reports', async ({ page }) => {
  await mockPayroll(page)
  const errors = [], assets = [], requests = [], ratings = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', response => { if (response.url().includes('/ui-templates/')) assets.push(response) })
  await page.route('**/agent-studio/graphql', async route => {
    const { query, variables } = route.request().postDataJSON()
    if (!query.includes('RateAnswer')) return route.fallback()
    ratings.push(variables.input)
    await route.fulfill({ json: { data: { rateAnswer: true } } })
  })
  const report = { id: 'INC-123', title: 'Review overtime', severity: 'warning', totalAtRisk: 100,
    writtenBy: 'evidence', report: '# Payroll incident\nReview overtime before approval.',
    evidence: [{ id: 'E1', name: 'Maya Chen', finding: 'Overtime changed', amountAtRisk: 100 }],
    email: { status: 'sent', to: 'payroll@example.test' }, slack: { status: 'off' } }
  await page.route('**/webhook/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body)
    await route.fulfill({ json: { reply: body.context.task ? 'Incident created.' : 'Review overtime before approving.',
      answeredBy: 'payroll-data', interactionId: 'interaction-123', incident: body.context.task ? report : undefined,
      session: { id: body.sessionId || 'a'.repeat(64) },
      retrieval: { sources: [{ id: 'source-1', employeeId: 'E1001', payrunId: 'PR-2026-09-A', topic: 'overtime', cited: true }] } } })
  })
  await page.goto(`${payrollUrl}?domain=payroll-services&payrun=PR-2026-09-B`)
  await expect(page.getByRole('button', { name: 'Maya Chen', exact: true })).toBeVisible()
  expect(assets).toHaveLength(0)
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  const ui = assistant(page)
  await expect(ui.getByRole('heading', { name: 'Payroll Assistant' })).toBeVisible()
  await expect(ui.getByLabel('Agent', { exact: true })).toBeEnabled()
  expect(await ui.locator('payrun-assistant').getAttribute('ng-version')).toMatch(/^21\./)
  expect(assets.some(asset => asset.url().endsWith('/manifest.json'))).toBe(true)
  expect(assets.some(asset => /main-.*\.js$/.test(asset.url()))).toBe(true)
  expect(assets.every(asset => asset.ok())).toBe(true)

  await ui.getByRole('button', { name: /All questions/ }).click()
  await ui.getByRole('searchbox', { name: 'Search questions' }).fill('total gross')
  await ui.getByRole('button', { name: 'What is the total gross pay for this payrun?', exact: true }).click()
  await expect(ui.locator('.tn-copilot-thread')).toContainText('Review overtime before approving.')
  await expect(ui.getByRole('dialog', { name: 'All questions' })).toHaveCount(0)
  await expect(ui.locator('.tn-copilot-source')).toHaveText('Computed from payroll data')
  await ui.getByText('Historical sources (1)', { exact: true }).click()
  await expect(ui.locator('.tn-copilot-thread')).toContainText('PR-2026-09-A')
  await ui.getByRole('button', { name: 'Helpful', exact: true }).click()
  await expect(ui.getByRole('button', { name: 'Helpful', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(ratings[0]).toEqual({ domainName: 'payroll-services', interactionId: 'interaction-123', rating: 'up' })
  await ui.getByRole('button', { name: 'Create incident report with Scope incident' }).click()
  await expect(ui.getByLabel('Incident INC-123')).toContainText('Emailed to payroll@example.test')
  await ui.getByRole('button', { name: 'View report' }).click()
  await expect(ui.locator('.tn-incident-report')).toContainText('# Payroll incident')
  const download = page.waitForEvent('download')
  await ui.getByRole('button', { name: 'Download report' }).click()
  expect((await download).suggestedFilename()).toBe('INC-123.md')
  expect(requests[1].context.handoff.conversation).toHaveLength(2)
  await ui.getByRole('button', { name: 'New chat' }).click()
  await expect(ui.locator('.tn-copilot-thread')).not.toContainText('Review overtime before approving.')
  await ui.getByRole('textbox', { name: 'Ask Scope AD' }).fill('Try again')
  await ui.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(ui.getByLabel('Agent', { exact: true })).toBeEnabled()
  expect(requests[2].sessionId).toBeUndefined()
  expect(errors).toEqual([])
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
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
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
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
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
  await ui.getByRole('button', { name: 'Close assistant' }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await expect(ui.getByText(/No agents are attached to the payrun page yet/)).toBeVisible()
  await expect(ui.getByLabel('Agent', { exact: true })).toHaveCount(0)
})
