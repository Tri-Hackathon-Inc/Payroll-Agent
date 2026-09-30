import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

test('editing unsaved payroll checks the latest input without saving and rejects stale responses', async ({ page }) => {
  const run = JSON.parse(readFileSync(new URL('../../backend/registry/fixtures/payrun-PR-2026-09-B.json', import.meta.url), 'utf8')).payrun
  run.lines.forEach((line, index) => { line.lineId ||= `line-${index}` })
  const employee = run.lines.find(line => line.payType === 'hourly')
  const checks = [], mutations = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/graphql', async route => {
    const request = route.request().postDataJSON()
    if (request.query.includes('mutation')) mutations.push(request)
    if (route.request().url().includes('agent-studio')) return route.fulfill({ json: { data: { listDomains: [{ name: 'payroll-services', label: 'Payroll', domain: 'Payroll' }] } } })
    return route.fulfill({ json: { data: { payrun: run } } })
  })
  await page.route('**/events/stream?**', route => route.fulfill({ contentType: 'text/event-stream', body: ': ready\n\n' }))
  await page.route('**/events/preview', async route => {
    const body = route.request().postDataJSON(); checks.push(body)
    const overtime = body.changes.hours?.overtime
    if (overtime === 150) await new Promise(resolve => setTimeout(resolve, 800))
    try {
      await route.fulfill({ json: { saved: false, derivedAmountsPending: true, analysis: {
        employees: [{ historyStatus: 'available' }], findings: overtime >= 100 ? [{ id: 'overtime', label: `Overtime hours changed to ${overtime}` }] : [],
      } } })
    } catch { /* A superseded request was aborted. */ }
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await page.getByRole('button', { name: employee.name, exact: true }).first().click()
  const overtime = page.getByRole('spinbutton', { name: 'Overtime hours', exact: true })
  await overtime.fill('150')
  await expect.poll(() => checks.length).toBe(1)
  await overtime.fill('180')
  await expect(page.getByText('Overtime hours changed to 180', { exact: true })).toBeVisible()
  await expect(page.getByText('Overtime hours changed to 150', { exact: true })).toHaveCount(0)
  expect(mutations).toEqual([])
  expect(checks.at(-1)).toMatchObject({ payrunId: run.id, expectedVersion: run.version, lineId: employee.lineId, changes: { hours: { overtime: 180 } } })
  await overtime.fill('999')
  await expect(page.getByText('Unsaved change check', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(mutations).toEqual([])
  expect(errors).toEqual([])
})
