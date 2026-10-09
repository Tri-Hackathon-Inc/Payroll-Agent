import { test, expect } from '@playwright/test'
import { basePath } from '../scripts/settings.mjs'

const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')

test('saved agent chat returns replies, preserves failures and resets history', async ({ page }) => {
  const name = `Chat agent ${Date.now()}`
  await page.goto(BASE)
  await page.locator('.service-card').filter({ has: page.getByText('Payroll', { exact: true }) }).click()
  await page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Anomaly Detection', exact: true }) }).getByRole('button', { name: 'Use Template' }).click()
  await page.getByLabel('Agent name', { exact: true }).fill(name)
  await page.getByRole('button', { name: 'Create agent', exact: true }).click()
  await expect(page.locator('.alert-success')).toContainText(name)
  await page.getByRole('navigation', { name: 'Agent Studio' }).getByRole('button', { name: 'My Agents' }).click()
  const card = page.locator('.my-agent-row').filter({ hasText: name })
  await card.getByRole('button', { name: 'Chat with agent' }).click()
  await expect(page.getByRole('heading', { name: `Chat with ${name}` })).toBeVisible()
  await page.getByLabel('Message', { exact: true }).fill('Hello agent')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('log')).toContainText('Demo response (no model inference): Hello agent')
  await page.route('**/graphql', async route => {
    if (route.request().postDataJSON().query.includes('mutation ChatAgent')) {
      await route.fulfill({ json: { errors: [{ message: 'Model temporarily unavailable.' }] } })
    } else await route.continue()
  })
  await page.getByLabel('Message', { exact: true }).fill('Try again')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('alert').filter({ hasText: 'Model temporarily unavailable' })).toBeVisible()
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue('Try again')
  await page.unroute('**/graphql')
  const requestPromise = page.waitForRequest(request => request.method() === 'POST' && request.postDataJSON()?.query.includes('mutation ChatAgent'))
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  const request = await requestPromise
  expect(request.postDataJSON().variables.input.history).toHaveLength(2)
  await expect(page.getByRole('log')).toContainText('Demo response (no model inference): Try again')
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expect(page.getByRole('log')).not.toContainText('Hello agent')
})
