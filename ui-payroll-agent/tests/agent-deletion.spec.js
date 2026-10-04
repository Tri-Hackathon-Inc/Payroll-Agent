import { test, expect } from '@playwright/test'
import { basePath } from '../scripts/settings.mjs'
import { CREATE_AGENT_MUTATION } from '../src/graphql/operations.js'

const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')

test('My Agents deletion supports cancel, failure, retry and removal', async ({ page, request }) => {
  const name = `Delete browser test ${Date.now()}`
  const created = await request.post(`${BASE}graphql`, { data: { query: CREATE_AGENT_MUTATION, variables: { input: {
    domainName: 'payroll-services', templateId: 'anomaly-detection', name, config: {},
  } } } })
  expect((await created.json()).errors).toBeUndefined()
  await page.goto(BASE)
  await page.getByRole('button', { name: 'My Agents', exact: true }).click()
  const row = page.locator('.my-agent-row').filter({ hasText: name })
  await expect(row).toBeVisible()
  page.once('dialog', dialog => dialog.dismiss())
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click()
  await expect(row).toBeVisible()
  await page.route('**/graphql', route => {
    if (route.request().postDataJSON().query.includes('mutation DeleteAgent')) {
      return route.fulfill({ json: { errors: [{ message: 'Deletion unavailable. Try again.' }] } })
    }
    return route.continue()
  })
  page.once('dialog', dialog => dialog.accept())
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Deletion unavailable')
  await expect(row).toBeVisible()
  await page.unroute('**/graphql')
  page.once('dialog', dialog => dialog.accept())
  await row.getByRole('button', { name: `Delete ${name}`, exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByRole('status')).toContainText(`Deleted "${name}"`)
  await page.reload()
  await page.getByRole('button', { name: 'My Agents', exact: true }).click()
  await expect(row).toHaveCount(0)
})
