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

test('completed investigation discovers a receiver but transfers context only on Report to Incident Agent', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const completed = { ...item, reviewStatus: 'completed', investigation: { modelStatus: 'completed', summary: 'Verify the bonus.', findings: [], evidence: [] } }
  const messages = []
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [completed] } }))
  await page.route('**/agent-messages', route => {
    const body = route.request().postDataJSON()
    messages.push(body)
    return route.fulfill({ json: body.action === 'DISCOVER'
      ? { agents: [{ id: 'incident-agent', name: 'Incident Reports' }] }
      : { id: 'message-1', status: 'completed', result: { incident: { id: 'INC-test', report: '# Incident report\nVerify the bonus.' } } } })
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect(page.getByRole('button', { name: 'Report to Incident Agent', exact: true })).toBeVisible()
  expect(messages.filter(value => value.action === 'SEND')).toHaveLength(0)
  await page.getByRole('button', { name: 'Report to Incident Agent', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Incident report created.' })).toBeVisible()
  expect(messages.filter(value => value.action === 'SEND')).toEqual([expect.objectContaining({
    targetAgentId: 'incident-agent', agentId: item.agentId, responseId: item.id, expectedVersion: item.version,
  })])
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Download incident report' }).click()
  expect((await download).suggestedFilename()).toBe('INC-test.md')
})

test('Jev waits for user Review, supports minimizing, and has no AD report download', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const calls = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/anomalies/review', async route => {
    calls.push(route.request().postDataJSON())
    await gate
    return route.fulfill({ json: { ...item, reviewStatus: 'completed', investigation: { modelStatus: 'completed',
      summary: 'Verify the approved bonus.', findings: [], evidence: [{ id: 'source-1' }] } } })
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect.poll(() => page.evaluate(() => window.payrollStreams.length)).toBeGreaterThan(0)
  await page.evaluate(item => window.payrollStreams.at(-1).emit({ type: 'scanning', domainName: item.domainName, payrunId: item.payrunId }), item)
  await expect(page.getByText('Jev is actively scanning for payroll issues…', { exact: true })).toBeVisible()
  await page.evaluate(item => {
    const event = { type: 'checked', domainName: item.domainName, payrunId: item.payrunId, version: item.version,
      anomaly: { ...item, decisionModel: { status: 'completed', decision: 'REVIEW' } } }
    window.payrollStreams.at(-1).emit(event)
    window.payrollStreams.at(-1).emit(event)
  }, item)
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download Report', exact: true })).toHaveCount(0)
  expect(calls).toHaveLength(0)
  await page.getByRole('button', { name: 'Minimize AD agent' }).click()
  await expect(page.getByRole('button', { name: 'Review', exact: true })).not.toBeVisible()
  expect(calls).toHaveLength(0)
  await page.getByRole('button', { name: 'Expand AD agent' }).click()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.getByText('Investigating flagged findings…', { exact: true })).toBeVisible()
  await expect(page.getByText(item.summary, { exact: true })).not.toBeVisible()
  expect(calls).toHaveLength(1)
  release()
  await expect(page.getByText('Verify the approved bonus.', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Download Report', exact: true })).toHaveCount(0)
  expect(calls).toHaveLength(1)
})

test('partial investigation leads with explanations and keeps unexplained findings visible', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  item.createdAt = '2026-09-30T10:00:00Z'
  item.findings.push({ id: 'net-change', employeeId: 'E1', label: 'Net pay changed' })
  item.reviewStatus = 'failed'
  item.investigation = { modelStatus: 'partial_response', summary: 'The bonus needs approval verification.', reason: 'The model explained 1 of 2 findings.',
    findings: [{ findingId: 'bonus-change', explanation: 'The bonus exceeds its baseline.', reviewAction: 'Verify approval.' }], evidence: [] }
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [item] } }))
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect(page.getByText('The bonus needs approval verification.', { exact: true })).toBeVisible()
  await expect(page.getByText(item.summary, { exact: true })).not.toBeVisible()
  await expect(page.getByText('Some findings still need manual review.', { exact: true })).toBeVisible()
  await expect(page.getByText('Findings and evidence', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Download Report', exact: true })).toHaveCount(0)
  await page.evaluate(item => window.payrollStreams.at(-1).emit({ type: 'checked', domainName: item.domainName, payrunId: item.payrunId,
    version: item.version, anomaly: { ...item, id: 'new-check', createdAt: '2026-09-30T11:00:00Z' } }), item)
  await expect(page.getByRole('article')).toHaveCount(1)
})

test('admin explanation supports audited dismissal without investigation', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  item.adminSummary = { summary: '3 checks flagged across 1 employee.', priorities: [{ subject: 'Employee E1', items: ['Bonus exceeds previous payments.'] }], remainingGroups: 0,
    limitations: ['Additional model scoring was unavailable.'], nextStep: 'Verify approved bonus records.' }
  const feedback = [], reviews = []
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [item] } }))
  await page.route('**/anomalies/review', route => { reviews.push(1); return route.fulfill({ json: item }) })
  await page.route('**/anomalies/feedback', route => {
    const body = route.request().postDataJSON(); feedback.push(body)
    item.feedback = { action: body.action, note: body.note }
    return route.fulfill({ json: item })
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect(page.getByText('1 employee flagged. Select Review to investigate.', { exact: true })).toBeVisible()
  await expect(page.getByText('Bonus payment exceeds historical levels.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Dismiss as expected', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Confirm dismissal', exact: true })).toBeDisabled()
  await page.getByLabel('Why are these payments expected?').fill('Approved annual bonus')
  await page.getByRole('button', { name: 'Confirm dismissal', exact: true }).click()
  await expect(page.getByText('Dismissed by reviewer', { exact: true })).toBeVisible()
  expect(feedback[0]).toMatchObject({ action: 'DISMISSED', note: 'Approved annual bonus', expectedVersion: run.version })
  expect(reviews).toEqual([])
  await page.reload()
  await expect(page.getByText('Dismissed by reviewer', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
})

test('opening a paycheck requests fresh scoped source data before editing', async ({ page }) => {
  const { run } = await payrollPage(page)
  const employee = run.lines.find(line => line.payType === 'hourly')
  const requests = []
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/graphql', route => {
    if (route.request().url().includes('agent-studio')) return route.fallback()
    const request = route.request().postDataJSON()
    requests.push(request)
    if (request.query.includes('EmployeePaycheck')) {
      run.version++
      employee.hours.overtime = 7
    }
    return route.fulfill({ json: { data: { payrun: run } } })
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect(page.getByRole('button', { name: employee.name, exact: true }).first()).toBeVisible()
  expect(requests).toHaveLength(1)
  await page.getByRole('button', { name: employee.name, exact: true }).first().click()
  await expect(page.getByRole('spinbutton', { name: 'Overtime hours', exact: true })).toHaveValue('7')
  expect(requests).toHaveLength(2)
  expect(requests[0].query).toContain('monitor: true')
  expect(requests[1].query).toContain('checkLineId: $lineId')
  expect(requests[1].variables).toEqual({ id: run.id, domainName: 'payroll-services', lineId: employee.lineId })
})

test('saving rechecks the open employee and returning rechecks the whole payrun', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const employee = run.lines[0]
  const requests = []
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/events/preview', route => route.fulfill({ json: { saved: false, analysis: { findings: [], employees: [] } } }))
  await page.route('**/graphql', route => {
    if (route.request().url().includes('agent-studio')) return route.fallback()
    const body = route.request().postDataJSON()
    requests.push(body)
    if (body.query.includes('mutation UpdatePayLine')) {
      run.version++
      employee.earnings.bonus = body.variables.input.earnings.bonus
      return route.fulfill({ json: { data: { updatePayLine: run } } })
    }
    return route.fulfill({ json: { data: { payrun: run } } })
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await page.getByRole('button', { name: employee.name, exact: true }).first().click()
  const drawer = page.getByRole('complementary', { name: 'Edit employee pay' })
  await drawer.getByRole('spinbutton', { name: 'Bonus', exact: true }).fill('777')
  await drawer.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(drawer.getByRole('spinbutton', { name: 'Bonus', exact: true })).toHaveValue('777')
  await expect.poll(() => requests.filter(body => body.query.includes('EmployeePaycheck')).length).toBe(2)
  await page.evaluate(item => window.payrollStreams.at(-1).emit({ type: 'checked', domainName: item.domainName,
    payrunId: item.payrunId, version: item.version, scope: item.scope, anomaly: item }), {
    ...item, id: 'fresh-employee', version: run.version, scope: employee.employeeId, reviewStatus: 'pending', investigation: null,
  })
  await expect(drawer.getByRole('button', { name: 'Review', exact: true })).toBeVisible()
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect.poll(() => requests.filter(body => body.query.includes('query Payrun(')).length).toBe(2)
  expect(requests.at(-1).query).toContain('monitor: true')
  await expect(drawer).toHaveCount(0)
})

test('new payroll versions refresh an open employee without overwriting unsaved edits', async ({ page }) => {
  const { run } = await payrollPage(page)
  const employee = run.lines[0]
  let reads = 0
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [] } }))
  await page.route('**/events/preview', route => route.fulfill({ json: { saved: false, analysis: { findings: [], employees: [] } } }))
  await page.route('**/graphql', route => {
    if (route.request().url().includes('agent-studio')) return route.fallback()
    if (route.request().postDataJSON().query.includes('EmployeePaycheck')) reads++
    return route.fulfill({ json: { data: { payrun: run } } })
  })
  const emit = () => page.evaluate(event => window.payrollStreams.at(-1).emit(event), {
    type: 'checked', domainName: 'payroll-services', payrunId: run.id, version: run.version,
    analysis: { findings: [], employees: [], payrunFindings: [] }, monitor: { name: 'AD' },
  })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await page.getByRole('button', { name: employee.name, exact: true }).first().click()
  run.version++
  employee.earnings.bonus = 888
  await emit()
  await expect(page.getByRole('spinbutton', { name: 'Bonus', exact: true })).toHaveValue('888')
  expect(reads).toBe(2)
  await page.getByRole('spinbutton', { name: 'Bonus', exact: true }).fill('999')
  run.version++
  employee.earnings.bonus = 1000
  await emit()
  await expect(page.getByText(/Payroll changed elsewhere/)).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Bonus', exact: true })).toHaveValue('999')
  expect(reads).toBe(2)
})

test('opening an employee clears the payrun conclusion and shows only that employee case', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const employee = run.lines[0]
  const whole = { ...item, reviewStatus: 'completed', investigation: { modelStatus: 'completed', summary: 'Whole payrun conclusion.', findings: [], evidence: [] } }
  const scoped = { ...item, id: 'employee-case', scope: employee.employeeId, reviewStatus: 'completed', investigation: { modelStatus: 'completed', summary: 'Employee bonus requires approval.', findings: [], evidence: [] } }
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [whole, scoped] } }))
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect(page.getByText('Whole payrun conclusion.', { exact: true })).toBeVisible()
  await expect(page.getByText('Employee bonus requires approval.', { exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: employee.name, exact: true }).first().click()
  await expect(page.getByText('Whole payrun conclusion.', { exact: true })).toHaveCount(0)
  const drawer = page.getByRole('complementary', { name: 'Edit employee pay' })
  await expect(drawer.getByText('Employee bonus requires approval.', { exact: true })).toBeVisible()
  await expect(page.getByRole('article')).toHaveCount(1)
  await drawer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByText('Whole payrun conclusion.', { exact: true })).toBeVisible()
  await expect(page.getByText('Employee bonus requires approval.', { exact: true })).toHaveCount(0)
})

test('employee stream results preserve the whole-payrun analysis', async ({ page }) => {
  const { run } = await payrollPage(page)
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [] } }))
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  await expect.poll(() => page.evaluate(() => window.payrollStreams.length)).toBeGreaterThan(0)
  const emit = event => page.evaluate(event => window.payrollStreams.at(-1).emit(event), event)
  const base = { type: 'checked', domainName: 'payroll-services', payrunId: run.id, version: run.version,
    monitor: { name: 'Payroll monitor' }, findings: [], critical: 0 }
  await emit({ ...base, analysis: { payrunFindings: [{ label: 'Whole payroll finding' }], findings: [] } })
  await expect(page.getByText('Whole payroll finding. Review against historical payroll.', { exact: true })).toBeVisible()
  await emit({ ...base, scope: run.lines[0].employeeId, analysis: { employeeId: run.lines[0].employeeId, payrunFindings: [], findings: [] } })
  await expect(page.getByText('Whole payroll finding. Review against historical payroll.', { exact: true })).toBeVisible()
})

test('anomalies persist and only an explicit Review invokes investigation once', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const reviewCalls = [], feedbackCalls = [], listCalls = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  let current = item
  let release
  const modelReply = new Promise(resolve => { release = resolve })
  await page.route('**/anomalies/feedback', route => {
    const body = route.request().postDataJSON()
    feedbackCalls.push(body)
    current = { ...current, feedback: { action: body.action, note: '', createdAt: 'now' } }
    return route.fulfill({ json: current })
  })
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
  await expect(card.getByRole('button', { name: 'Review', exact: true })).toHaveCount(0)
  await expect(card.getByText('history-1', { exact: true })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Download Report', exact: true })).toHaveCount(0)
  await card.getByRole('button', { name: 'Confirm finding', exact: true }).click()
  await expect(card.getByText('Feedback saved: finding confirmed', { exact: true })).toBeVisible()
  expect(feedbackCalls).toHaveLength(1)
  expect(feedbackCalls[0]).toMatchObject({ domainName: item.domainName, agentId: item.agentId, anomalyId: item.id, expectedVersion: item.version, action: 'CONFIRMED' })
  expect(feedbackCalls[0].requestId).toMatch(/^[a-f0-9-]{36}$/)
  await page.reload()
  await expect(card.getByText('Investigation conclusion', { exact: true })).toBeVisible()
  await expect(card.getByText('Feedback saved: finding confirmed', { exact: true })).toBeVisible()
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

test('a failed investigation shows its actual reason and retains calculated findings', async ({ page }) => {
  const { run, item } = await payrollPage(page)
  const reason = 'Select an employee to reduce the evidence for investigation.'
  const failed = { ...item, reviewStatus: 'failed', investigation: {
    modelStatus: 'context_limit', summary: item.summary, reason, findings: [], evidence: [],
  } }
  const reviews = []
  await page.route('**/anomalies?**', route => route.fulfill({ json: { items: [failed] } }))
  await page.route('**/anomalies/review', route => { reviews.push(route.request().postDataJSON()); return route.fulfill({ json: failed }) })
  await page.goto(`/trinet/?domain=payroll-services&payrun=${run.id}`)
  const card = page.getByRole('article', { name: 'Payroll monitor: Needs review', exact: true })
  await expect(card.getByRole('alert')).toHaveText(reason)
  await expect(card.getByText('Investigation could not complete. Select Review to retry.')).toHaveCount(0)
  await expect(card.getByText(/Unusual bonus/)).toBeVisible()
  await expect(card.getByRole('button', { name: 'Review', exact: true })).toBeEnabled()
  expect(reviews).toEqual([])
})
