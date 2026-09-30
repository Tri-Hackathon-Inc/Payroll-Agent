import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'

async function payrollPage(page) {
  const run = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/payrun-PR-2026-09-B.json', import.meta.url), 'utf8')).payrun
  run.lines.forEach((line, index) => { line.lineId ||= `line-${index}` })
  await page.addInitScript(() => {
    window.payrollStreams = []
    window.EventSource = class {
      listeners = {}
      constructor(url) { this.url = url; window.payrollStreams.push(this); setTimeout(() => this.onopen?.(), 0) }
      addEventListener(name, callback) { this.listeners[name] = callback }
      close() { this.closed = true }
      emit(event) { this.listeners.payroll?.({ data: JSON.stringify(event) }) }
    }
  })
  await page.route('**/graphql', route => route.fulfill({ json: { data: route.request().url().includes('agent-studio')
    ? { listDomains: [{ name: 'payroll-services', label: 'Payroll', domain: 'Payroll' }] }
    : { payrun: run } } }))
  return { run, item: { id: 'case-1', domainName: 'payroll-services', agentId: 'agent-1', agentName: 'Payroll monitor', payrunId: run.id,
    version: run.version, decision: 'REVIEW', reviewStatus: 'pending', summary: 'Bonus payment exceeds historical levels.',
    findings: [{ id: 'bonus-change', employeeId: run.lines[0].employeeId, kind: 'bonus', severity: 'warning', label: 'Bonus increase' }], investigation: null } }
}

test('anomalies persist and only an explicit Review invokes investigation once', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const reviewCalls = [], listCalls = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  let current = item
  let release
  const modelReply = new Promise(resolve => { release = resolve })
  await page.route('**/anomalies?**', route => {
    listCalls.push(route.request().url())
    return route.fulfill({ json: { items: [current, { ...current, id: 'other-domain', domainName: 'other' }] } })
  })
  await page.route('**/anomalies/review', async route => {
    reviewCalls.push(route.request().postDataJSON())
    await modelReply
    current = { ...item, reviewStatus: 'completed', investigation: { summary: 'The bonus is higher than the previous three eligible payruns.',
      modelStatus: 'completed', findings: item.findings, evidence: [{ id: 'history-1', payrunId: 'PR-previous', employeeId: item.findings[0].employeeId }] } }
    await route.fulfill({ json: current })
  })
  await page.clock.install()
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  const card = page.getByRole('article', { name: 'Payroll monitor: Needs review', exact: true })
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('button', { name: 'Review', exact: true })).toBeEnabled()
  expect(reviewCalls).toEqual([])
  await page.evaluate(({ run, item }) => {
    const stream = window.payrollStreams.at(-1)
    stream.emit({ type: 'checked', domainName: item.domainName, payrunId: run.id, version: run.version, anomaly: item })
    for (let i = 0; i < 6; i++) stream.emit({ type: 'checked', domainName: item.domainName, payrunId: run.id, version: run.version,
      monitor: { name: 'Payroll monitor' }, anomaly: { ...item, id: `normal-${i}`, decision: 'NORMAL' } })
  }, { run, item })
  await page.clock.fastForward(11000)
  await expect(card).toHaveCount(1)
  expect(reviewCalls).toEqual([])
  const reads = listCalls.length
  await page.evaluate(() => window.payrollStreams.at(-1).onopen())
  await expect.poll(() => listCalls.length).toBeGreaterThan(reads)
  await expect(card).toHaveCount(1)
  expect(reviewCalls).toEqual([])
  await card.getByRole('button', { name: 'Review', exact: true }).click()
  const investigating = card.getByRole('button', { name: 'Investigating...', exact: true })
  await expect(investigating).toBeDisabled()
  await investigating.evaluate(button => { button.click(); button.click() })
  expect(reviewCalls).toEqual([{ domainName: item.domainName, agentId: item.agentId, anomalyId: item.id, action: 'REVIEW', expectedVersion: item.version }])
  release()
  await expect(card.getByText('The bonus is higher than the previous three eligible payruns.', { exact: true })).toBeVisible()
  await expect(card.getByRole('button')).toHaveCount(0)
  await card.getByText('Findings and evidence', { exact: true }).click()
  await expect(card.getByText('history-1', { exact: true })).toBeVisible()
  await page.reload()
  await expect(card.getByText('Investigation complete', { exact: true })).toBeVisible()
  expect(reviewCalls).toHaveLength(1)
  expect(errors).toEqual([])
})

test('a stale Review refreshes the case without automatically retrying the model', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  let current = item
  let calls = 0
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [current] } }))
  await page.route('**/anomalies/review', route => {
    calls++
    current = { ...item, reviewStatus: 'investigating' }
    return route.fulfill({ status: 409, json: { error: 'Investigation is already running.' } })
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Investigating...', exact: true })).toBeDisabled()
  await expect(page.getByText('This review changed. The latest saved reviews have been refreshed.', { exact: true })).toBeVisible()
  expect(calls).toBe(1)
  current = { ...item, reviewStatus: 'completed', investigation: { summary: 'Another reviewer completed this investigation.', findings: [], evidence: [], modelStatus: 'completed' } }
  await page.evaluate(() => window.payrollStreams.at(-1).onopen())
  await expect(page.getByText('Another reviewer completed this investigation.', { exact: true })).toBeVisible()
  expect(calls).toBe(1)
})

test('a newer normal check supersedes old pending cases and stale stream events stay hidden', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const reviews = []
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [item] } }))
  await page.route('**/anomalies/review', route => { reviews.push(route.request().postDataJSON()); return route.fulfill({ json: item }) })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
  run.version = item.version + 1
  await page.evaluate(({ run, item }) => {
    const stream = window.payrollStreams.at(-1)
    stream.emit({ type: 'checked', domainName: item.domainName, payrunId: run.id, version: run.version, monitor: { name: 'Payroll monitor' },
      anomaly: { ...item, id: 'normal-newer', decision: 'NORMAL', reviewStatus: 'not_required', version: run.version } })
    stream.emit({ type: 'checked', domainName: item.domainName, payrunId: run.id, version: item.version, anomaly: item })
    stream.emit({ type: 'checked', domainName: item.domainName, payrunId: 'different-run', version: run.version + 20,
      anomaly: { ...item, payrunId: 'different-run', version: run.version + 20 } })
  }, { run, item })
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await page.evaluate(() => window.payrollStreams.at(-1).onopen())
  await expect(page.getByRole('article')).toHaveCount(0)
  expect(reviews).toEqual([])
})
