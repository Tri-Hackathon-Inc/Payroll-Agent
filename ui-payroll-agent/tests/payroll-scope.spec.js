import { test, expect } from '@playwright/test'

import { assistant, mockPayroll, payrollUrl } from './payrun-fixture.js'

// Production runtime embedded in the TriNet host; API responses are deterministic fixtures.
test.skip(!process.env.TRINET_UI_URL, 'Use playwright.runtime.config.js for the host integration.')

async function openPayroll(page) {
  const requests = []
  await mockPayroll(page)
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
  await expect(assistant(page).getByLabel('Agent', { exact: true })).toBeEnabled()
  const suggested = assistant(page).getByRole('button', { name: 'Which payments need review?', exact: true })
  if (await suggested.isVisible()) await suggested.click()
  else {
    await assistant(page).getByRole('textbox', { name: /^Ask / }).fill('Which payments need review?')
    await assistant(page).getByRole('button', { name: 'Send', exact: true }).click()
  }
  await expect(assistant(page).getByLabel('Agent', { exact: true })).toBeEnabled()
}

test('payroll employee selection survives opening, reopening and changing the assistant agent', async ({ page }) => {
  const requests = await openPayroll(page)
  await page.getByRole('button', { name: 'Maya Chen', exact: true }).click()
  await page.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await askSuggested(page)
  expect(requests[0].context.employeeId).toBe('E1001')
  await expect(assistant(page).getByLabel('Employee scope')).toHaveValue('E1001')
  await expect(assistant(page).getByRole('status')).toContainText('Reviewing Maya Chen (E1001) only.')

  await assistant(page).getByRole('button', { name: 'Close assistant', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await askSuggested(page)
  expect(requests[1].context.employeeId).toBe('E1001')
  expect(requests[1].sessionId).toBe('1'.repeat(64))

  await assistant(page).getByLabel('Agent', { exact: true }).selectOption('scope-summary')
  await askSuggested(page)
  expect(requests[2].context.employeeId).toBe('E1001')
  expect(requests[2].sessionId).toBeUndefined()

  await assistant(page).getByLabel('Employee scope').selectOption('E1002')
  await askSuggested(page)
  expect(requests[3].context.employeeId).toBe('E1002')
  expect(requests[3].sessionId).toBeUndefined()
  await expect(assistant(page).locator('.tn-copilot-thread')).not.toContainText('Review for E1001.')

  await assistant(page).getByRole('button', { name: 'Create incident report with Scope incident' }).click()
  await expect(assistant(page).getByLabel('Agent', { exact: true })).toBeEnabled()
  const incident = requests.pop()
  expect(incident.context).toMatchObject({ employeeId: 'E1002', task: 'incident-report' })
  expect(incident.context.handoff.conversation.map(item => item.text).join(' ')).toContain('Review for E1002.')
  expect(incident.context.handoff.conversation.map(item => item.text).join(' ')).not.toContain('Review for E1001.')

  await assistant(page).getByLabel('Employee scope').selectOption('')
  await askSuggested(page)
  expect(requests[4].context.employeeId).toBeNull()
  expect(requests[4].sessionId).toBeUndefined()
  await expect(assistant(page).getByRole('status')).toContainText('Reviewing all employees')
  await assistant(page).getByRole('button', { name: 'Close assistant', exact: true }).click()
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await expect(assistant(page).getByLabel('Employee scope')).toHaveValue('')
})

test('saving an employee keeps that employee selected; changing payruns resets scope', async ({ page }) => {
  const requests = await openPayroll(page)
  await page.getByRole('button', { name: 'Maya Chen', exact: true }).click()
  const bonus = page.getByRole('spinbutton', { name: 'Bonus', exact: true })
  await bonus.fill(String(Number(await bonus.inputValue()) + 1))
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('status')).toContainText("Maya Chen's pay was saved")
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await askSuggested(page)
  expect(requests[0].context.employeeId).toBe('E1001')

  await assistant(page).getByRole('button', { name: 'Close assistant', exact: true }).click()
  await page.locator('.tn-back').click()
  // Browser navigation also changes the payrun without reloading the React app.
  await page.evaluate(() => {
    window.history.pushState({}, '', '?domain=payroll-services&payrun=PR-2026-09-A')
    window.dispatchEvent(new PopStateEvent('popstate'))
  })
  await page.getByRole('button', { name: /Payroll Assistant/ }).click()
  await expect(assistant(page).getByLabel('Employee scope')).toHaveValue('')
  await askSuggested(page)
  expect(requests[1].context).toMatchObject({ payrunId: 'PR-2026-09-A', employeeId: null })
  expect(requests[1].sessionId).toBeUndefined()
})
