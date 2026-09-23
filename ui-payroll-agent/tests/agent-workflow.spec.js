import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
test.beforeAll(() => {
  if (process.env.GRAPHQL_MODE !== 'backend') return
  if (!process.env.DATABASE_PATH) throw new Error('Set DATABASE_PATH to the isolated database used by your running test backend.')
  const python = process.env.PYTHON || path.join(root, '.venv/bin/python')
  for (const [name, label] of [['payroll-services', 'Payroll Services'], ['payroll-demo', 'Payroll Demo']]) {
    execFileSync(python, ['backend/manage.py', 'create_business', name, '--label', label, '--domain', 'Payroll'], { cwd: root })
  }
})

test('create, reload, edit, handle errors, and filter agents by business', async ({ page }) => {
  const name = `Payroll UI review ${Date.now()}`
  await page.goto('/ai-studio')
  await page.getByRole('button', { name: /Payroll Services.*Browse templates/ }).click()
  const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Anomaly Detection', exact: true }) })
  await card.getByRole('button', { name: 'Use Template' }).click()
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(/Compare payrun inputs/)
  await page.getByLabel('Agent name', { exact: true }).fill(name)
  await page.getByLabel('Instructions', { exact: true }).fill('Review unusual payments for this business only.')
  await page.getByLabel('Severity', { exact: true }).selectOption('critical')
  await page.getByLabel('Enable webhook', { exact: true }).check()
  await page.getByLabel('HTTPS destination', { exact: true }).fill('https://example.com/payroll-events')
  await page.getByLabel('Employee details', { exact: true }).check()
  await page.getByRole('button', { name: 'Create agent', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible()
  await page.reload()
  let agentCard = page.locator('.card').filter({ has: page.getByRole('heading', { name, exact: true }) })
  await agentCard.getByRole('button', { name: 'Edit agent' }).click()
  await page.reload()
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue(name)
  await expect(page.getByLabel('Severity', { exact: true })).toHaveValue('critical')
  await expect(page.getByLabel('Enable webhook', { exact: true })).toBeChecked()
  await expect(page.getByLabel('HTTPS destination', { exact: true })).toHaveValue('https://example.com/payroll-events')
  await expect(page.getByLabel('Employee details', { exact: true })).toBeChecked()

  await page.route('**/graphql', async route => {
    if (route.request().postDataJSON().query.includes('mutation UpdateAgent')) {
      await route.fulfill({ json: { errors: [{ message: 'Configuration rejected for testing.', extensions: { code: 'BAD_USER_INPUT' } }] } })
    } else await route.continue()
  })
  await page.getByLabel('Agent name', { exact: true }).fill(`${name} updated`)
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Configuration rejected')
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue(`${name} updated`)
  await expect(page.getByLabel('HTTPS destination', { exact: true })).toHaveValue('https://example.com/payroll-events')
  await page.unroute('**/graphql')

  await page.getByLabel('Enable alerts', { exact: true }).uncheck()
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'My agents', exact: true })).toBeVisible()
  await page.getByLabel('Business', { exact: true }).selectOption('payroll-demo')
  await expect(page.getByRole('status')).toHaveCount(0)
  await expect(page.getByRole('heading', { name: `${name} updated`, exact: true })).toHaveCount(0)
  await page.goBack()
  agentCard = page.locator('.card').filter({ has: page.getByRole('heading', { name: `${name} updated`, exact: true }) })
  await agentCard.getByRole('button', { name: 'Edit agent' }).click()
  await expect(page.getByLabel('Enable alerts', { exact: true })).not.toBeChecked()
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue('Review unusual payments for this business only.')
  await page.screenshot({ path: 'test-results/agent-configuration.png', fullPage: true })
})

test('template request failures can be retried', async ({ page }) => {
  await page.route('**/graphql', async route => {
    if (route.request().postDataJSON().query.includes('query GetTemplate')) {
      await route.fulfill({ json: { errors: [{ message: 'Template temporarily unavailable.' }] } })
    } else await route.continue()
  })
  await page.goto('/ai-studio/templates/anomaly-detection/config?business=payroll-services')
  await expect(page.getByRole('alert')).toContainText('Template temporarily unavailable')
  await page.unroute('**/graphql')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Anomaly Detection')
})
