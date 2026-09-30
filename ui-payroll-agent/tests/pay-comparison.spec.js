import { test, expect } from '@playwright/test'
import { basePath } from '../scripts/settings.mjs'

const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')
const period = (payrunId, periodStart, periodEnd, payDate) => ({ payrunId, periodStart, periodEnd, payDate })
const comparison = {
  employeeId: 'E1001', employeeName: 'Maya Chen', currency: 'USD',
  previous: period('PR-2026-09', '2026-04-25', '2026-05-08', '2026-05-12'),
  current: period('PR-2026-10', '2026-05-09', '2026-05-22', '2026-05-26'),
  rows: [
    ['gross', 'Gross pay', 'earning', 6762.61, 6346.15, -416.46],
    ['federal', 'Federal tax', 'withholding', 1084.21, 1015.38, -68.83],
    ['state', 'State tax', 'withholding', 352.16, 330.40, -21.76],
    ['fica', 'FICA', 'withholding', 517.23, 485.48, -31.75],
    ['health', 'Health benefits', 'withholding', 66.83, 40, -26.83],
    ['retirement401k', '401(k)', 'withholding', 0, 16.49, 16.49],
    ['garnishment', 'Garnishment', 'withholding', 0, 0, 0],
    ['net', 'Net pay', 'net', 4742.18, 4458.40, -283.78],
  ].map(([key, label, kind, previous, current, delta]) => ({ key, label, kind, previous, current, delta })),
  overtime: { previous: 416.46, current: 0, previousHours: 3.5, currentHours: 0 }, netChange: -283.78, reconciled: true,
}
const explanation = 'This period has no overtime pay. Gross pay decreased by $416.46; lower withholding partly offsets that change, leaving net pay $283.78 lower.'

test('confirmed payroll answers show responsive period cards with validated explanations and a text fallback', async ({ page }, testInfo) => {
  const errors = [], requests = []
  let fallback = false
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/graphql', async route => {
    if (!route.request().postDataJSON().query.includes('GetServiceAgentRegistry')) return route.continue()
    await route.fulfill({ json: { data: { getServiceAgentRegistry: [
      { id: 'compare-agent', name: 'Paycheck assistant', templateId: 'general-query', config: { page: 'payrun', questions: [] } },
    ] } } })
  })
  await page.route('**/webhook/**', async route => {
    const body = route.request().postDataJSON(); requests.push(body)
    if (!body.confirmation) return route.fulfill({ json: { status: 'confirmation_required', reply: 'Choose a question.', session: { id: 'comparison-session' },
      questionMapping: { id: 'mapping-1', originalQuery: body.question, expiresAt: Date.now() + 600000, embeddingModel: 'fixture',
        candidates: [{ id: 'question-1', text: 'Why did my net pay change?', distance: .1 }] } } })
    const payComparison = fallback ? { ...comparison, previous: null, netChange: null, reconciled: false,
      rows: comparison.rows.map(row => ({ ...row, previous: null, delta: null })) } : comparison
    await route.fulfill({ json: { status: 'answered', reply: fallback ? 'Calculated evidence only.' : explanation,
      answeredBy: 'rag', analysis: { modelStatus: fallback ? 'invalid_response' : 'completed', payComparison,
        details: 'Full calculated review: net pay changed by -283.78 USD.',
        modelAnswer: fallback ? null : { summary: explanation }, modelMessage: fallback ? 'Showing calculated evidence only.' : null } } })
  })
  await page.goto(BASE)
  // A minimal same-origin host exercises the published runtime and its real message contract.
  await page.evaluate(base => {
    const frame = document.createElement('iframe')
    frame.title = 'Comparison preview'; frame.style.cssText = 'width:800px;height:1800px;border:0;display:block;margin:auto'
    frame.src = `${base}ui-templates/payrun-assistant/index.html?instance=comparison`
    window.addEventListener('message', event => {
      if (event.source === frame.contentWindow && event.data.type === 'ready') frame.contentWindow.postMessage({
        protocol: 'agent-ui-v1', instance: 'comparison', type: 'context', context: {
          domain: { name: 'payroll-services', label: 'Payroll Services' },
          payrun: { id: 'PR-2026-10', employees: [{ employeeId: 'E1001', name: 'Maya Chen' }] }, employeeId: 'E1001', open: true,
        },
      }, location.origin)
    })
    document.body.replaceChildren(frame)
  }, BASE)
  const ui = page.frameLocator('iframe[title="Comparison preview"]')
  await ui.getByRole('textbox', { name: 'Ask Paycheck assistant' }).fill('Why is this paycheck $284 less than the last one?')
  await ui.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(ui.getByLabel('Paycheck comparison', { exact: true })).toHaveCount(0)
  await ui.getByRole('button', { name: /Confirm/ }).click()
  const cards = ui.getByLabel('Paycheck comparison', { exact: true })
  await expect(cards).toBeVisible()
  await expect(ui.getByLabel('Previous paycheck', { exact: true })).toContainText('$4,742.18')
  await expect(ui.getByLabel('Current paycheck', { exact: true })).toContainText('$4,458.40')
  await expect(cards).toContainText('Your net pay is $283.78 lower')
  await expect(cards).toContainText(explanation)
  await expect(cards.locator('.favorable').first()).toContainText('less withheld')
  const previous = await cards.locator('.period').first().boundingBox(), current = await cards.locator('.period.current').boundingBox()
  expect(Math.abs(previous.y - current.y)).toBeLessThan(2)
  expect(current.x).toBeGreaterThan(previous.x)
  const priorNet = await cards.locator('.period:not(.current) .net').boundingBox(), currentNet = await cards.locator('.current .net').boundingBox()
  expect(Math.abs(priorNet.y - currentNet.y)).toBeLessThan(3)
  await cards.screenshot({ path: testInfo.outputPath('pay-comparison-wide.png') })
  await expect(cards.locator('.comparison-details p')).toBeHidden();
  await ui.getByText('Full answer and calculated review', { exact: true }).click()
  await expect(cards).toContainText('Full calculated review: net pay changed by -283.78 USD.')
  await ui.getByText('Full answer and calculated review', { exact: true }).click()
  expect(requests).toHaveLength(2)
  expect(requests[1].confirmation).toEqual({ mappingId: 'mapping-1', questionId: 'question-1' })
  await page.locator('iframe').evaluate(frame => { frame.style.width = '360px'; frame.style.height = '2400px' })
  const narrowPrevious = await cards.locator('.period').first().boundingBox(), narrowCurrent = await cards.locator('.period.current').boundingBox()
  expect(narrowCurrent.y).toBeGreaterThan(narrowPrevious.y)
  expect(await cards.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await cards.screenshot({ path: testInfo.outputPath('pay-comparison-narrow.png') })
  fallback = true
  await ui.getByRole('button', { name: 'New chat', exact: true }).click()
  await ui.getByRole('textbox', { name: 'Ask Paycheck assistant' }).fill('Explain my current paycheck')
  await ui.getByRole('button', { name: 'Send', exact: true }).click()
  await ui.getByRole('button', { name: /Confirm/ }).click()
  await expect(cards).toContainText('Your current paycheck')
  await expect(cards).toContainText('No comparable payrun')
  await expect(cards).toContainText('Showing calculated evidence only.')
  await expect(cards).not.toContainText(explanation)
  expect(errors).toEqual([])
})
