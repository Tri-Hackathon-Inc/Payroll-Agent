import { test, expect } from '@playwright/test'
import { basePath } from '../vite.config.js'

const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
test.beforeAll(() => {
  if (process.env.GRAPHQL_MODE !== 'backend') return
  if (!process.env.DATABASE_PATH) throw new Error('Set DATABASE_PATH to the isolated database used by your running test backend.')
  const python = process.env.PYTHON || path.join(root, '.venv/bin/python')
  for (const [name, label] of [['payroll-services', 'Payroll Services'], ['payroll-demo', 'Payroll Demo']]) {
    execFileSync(python, ['backend/manage.py', 'create_domain', name, '--label', label, '--domain', 'Payroll'], { cwd: root })
  }
})

test('single page: choose template, configure, submit creates the agent', async ({ page }) => {
  const name = `Payroll UI review ${Date.now()}`
  await page.goto(BASE)
  await expect(page.getByRole('heading', { name: 'Choose a service' })).toBeVisible()
  for (const service of ['Benefits', 'Insurance', 'HR', 'Time off']) {
    await expect(page.locator('.service-card').filter({ has: page.getByText(service, { exact: true }) })).toBeDisabled()
  }
  await expect(page.getByLabel('Domain', { exact: true })).toHaveCount(0)
  const panel = page.getByRole('navigation', { name: 'Agent Studio' })
  await expect(panel.getByRole('button')).toHaveText(['Services', 'Tools & APIs', 'Models', 'My Agents', 'Evaluation'])
  await page.locator('.service-card').filter({ has: page.getByText('Payroll', { exact: true }) }).click()
  await expect(page.getByRole('heading', { name: 'Payroll templates' })).toBeVisible()
  await expect(page.getByLabel('Domain', { exact: true })).toHaveValue('payroll-services')
  await page.getByRole('button', { name: '← All services' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a service' })).toBeVisible()
  await page.locator('.service-card').filter({ has: page.getByText('Payroll', { exact: true }) }).click()

  const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Anomaly Detection', exact: true }) })
  await card.getByRole('button', { name: 'Use Template' }).click()
  await expect(page.getByLabel('Instructions', { exact: true })).toHaveValue(/Compare payrun inputs/)
  await expect(page.getByLabel('Agent name', { exact: true })).toBeInViewport()
  await page.getByLabel('Description', { exact: true }).click()
  await page.locator('.col-lg-4 .card').click()
  await expect(page.getByLabel('Agent name', { exact: true })).toBeVisible()
  await page.getByRole('heading', { name: 'Agent Studio', exact: true }).click()
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveCount(0)
  await page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Summarizer', exact: true }) }).getByRole('button', { name: 'Use Template' }).click()
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Summarizer')
  await card.getByRole('button', { name: 'Use Template' }).click()
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Anomaly Detection')
  await page.getByLabel('Agent name', { exact: true }).fill(name)
  await page.getByLabel('Instructions', { exact: true }).fill('Review unusual payments for this business only.')
  await page.getByLabel('Employee details', { exact: true }).check()
  const models = page.getByRole('radiogroup', { name: 'Model' })
  await expect(models.getByRole('radio')).toHaveCount(4)
  await expect(models).not.toContainText('Qwen')
  const llama = models.locator('.model-option').filter({ hasText: 'Llama 3.3' })
  await expect(llama).toContainText('MMLU-Pro 68.9')
  await expect(llama.getByRole('link', { name: 'Source' })).toHaveAttribute('href', 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct')
  await expect(models.locator('.model-option').filter({ hasText: 'Mistral Large' })).toContainText('No published score recorded')
  await llama.click()  // anywhere on the card selects it
  await expect(llama).toHaveClass(/model-option-selected/)

  await page.route('**/graphql', async route => {
    if (route.request().postDataJSON().query.includes('mutation CreateAgent')) {
      await route.fulfill({ json: { errors: [{ message: 'Configuration rejected for testing.', extensions: { code: 'BAD_USER_INPUT' } }] } })
    } else await route.continue()
  })
  await page.getByRole('button', { name: 'Create agent', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Configuration rejected')
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue(name)
  await page.unroute('**/graphql')

  await page.getByRole('button', { name: 'Create agent', exact: true }).click()
  await expect(page.locator('.alert-success')).toContainText(`${name} created for Payroll Services`)
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveCount(0)
  await expect(page).toHaveURL(new URL(BASE, 'http://127.0.0.1:5180').href)

  const saved = await page.request.post(`${BASE}graphql`, { data: {
    query: 'query ($d: String) { getServiceAgentRegistry(domainName: $d) { name config } }', variables: { d: 'payroll-services' },
  } })
  const agent = (await saved.json()).data.getServiceAgentRegistry.find(item => item.name === name)
  expect(agent.config.instructions).toBe('Review unusual payments for this business only.')
  expect(agent.config.attached_services).toContain('employee-details')
  expect(agent.config.model).toBe('llama-3-3-70b')
  await page.screenshot({ path: 'test-results/agent-configuration.png', fullPage: true })
  await expect(page.locator('.alert-success')).not.toContainText('Open in chat')

  await panel.getByRole('button', { name: 'My Agents' }).click()
  await expect(page.getByLabel('Domain', { exact: true })).toHaveCount(0)
  const payroll = page.getByRole('region', { name: 'Payroll agents' })
  const domainCard = payroll.locator('.card').filter({ hasText: 'Payroll Services' })
  const row = domainCard.locator('.my-agent-row').filter({ hasText: name })
  await expect(row).toBeVisible()
  await expect(row.getByRole('link', { name: /Open in payrun/ })).toHaveAttribute('href', /\/trinet\/\?domain=payroll-services$/)
  await page.getByLabel('Search agents', { exact: true }).fill(name)
  await expect(page.locator('.my-agent-row')).toHaveCount(1)
  await page.getByLabel('Search agents', { exact: true }).fill('no-such-agent')
  await expect(page.locator('.my-agent-row')).toHaveCount(0)
  for (const [item, heading] of [['Tools & APIs', /Tools/], ['Models', 'Model Library'], ['Evaluation', /Evaluation/]]) {
    await panel.getByRole('button', { name: item }).click()
    await expect(page.getByRole('heading', { name: heading }).first()).toBeVisible()
  }
  await panel.getByRole('button', { name: 'Services' }).click()
  await expect(page.getByRole('heading', { name: 'Choose a service' })).toBeVisible()
  await expect(page).toHaveURL(new URL(BASE, 'http://127.0.0.1:5180').href)
})

test('template request failures can be retried', async ({ page }) => {
  await page.route('**/graphql', async route => {
    if (route.request().postDataJSON().query.includes('query GetTemplate')) {
      await route.fulfill({ json: { errors: [{ message: 'Template temporarily unavailable.' }] } })
    } else await route.continue()
  })
  await page.goto(BASE)
  await page.locator('.service-card').filter({ has: page.getByText('Payroll', { exact: true }) }).click()
  const card = page.locator('.template-card').filter({ has: page.getByRole('heading', { name: 'Anomaly Detection', exact: true }) })
  await card.getByRole('button', { name: 'Use Template' }).click()
  await expect(page.getByRole('alert')).toContainText('Template temporarily unavailable')
  await page.unroute('**/graphql')
  await page.getByRole('button', { name: 'Retry' }).click()
  await expect(page.getByLabel('Agent name', { exact: true })).toHaveValue('Anomaly Detection')
})

test('chat sends a question to the agent webhook and shows the reply', async ({ page }) => {
  const name = `Chat agent ${Date.now()}`
  const create = await page.request.post(`${BASE}graphql`, { data: {
    query: 'mutation ($input: CreateAgentInput!) { createAgent(input: $input) { id } }',
    variables: { input: { domainName: 'payroll-services', templateId: 'general-query', name, config: {} } },
  } })
  expect((await create.json()).errors).toBeUndefined()

  await page.goto(`${BASE}?view=chat&domain=payroll-services`)
  const input = page.getByLabel('Message an agent', { exact: true })
  await input.fill('@')
  await page.getByRole('option', { name: new RegExp(name) }).click()
  await input.fill('Why did net pay change?')
  await page.getByRole('button', { name: 'Send message' }).click()
  await expect(page.locator('.chat-message.agent .message-bubble').last()).toContainText(`${name} received your question`)
})

test('tools page lists payroll APIs and the demo notification tools', async ({ page }) => {
  await page.goto(BASE)
  await page.getByRole('navigation', { name: 'Agent Studio' }).getByRole('button', { name: 'Tools & APIs' }).click()
  await expect(page.locator('.tool-card')).toHaveCount(8)
  for (const [tool, kind] of [['Slack alert webhook', 'Webhook'], ['Email notification', 'Notification'], ['On-call alerting', 'Alerting'], ['OpenSearch event sink', 'Observability']]) {
    const card = page.locator('.tool-card').filter({ has: page.getByRole('heading', { name: tool, exact: true }) })
    await expect(card).toContainText(kind)
    await expect(card).toContainText('Demo only')
  }
  const payrun = page.locator('.tool-card').filter({ has: page.getByRole('heading', { name: 'Payrun service', exact: true }) })
  await expect(payrun).toContainText('Payroll API')
  await expect(payrun).not.toContainText('Demo only')
  await page.getByLabel('Search tools', { exact: true }).fill('slack')
  await expect(page.locator('.tool-card')).toHaveCount(1)
})

test('model library comes from the backend catalog and filters by license', async ({ page }) => {
  await page.goto(BASE)
  await page.getByRole('navigation', { name: 'Agent Studio' }).getByRole('button', { name: 'Models' }).click()
  const filters = page.getByRole('group', { name: 'Filter models' })
  const cards = page.locator('.model-card')
  await expect(cards).toHaveCount(5)
  await filters.getByRole('button', { name: /Open source/ }).click()
  await expect(cards).toHaveCount(2)
  await expect(cards.filter({ hasText: 'Qwen 2.5' })).toContainText('Qwen/Qwen2.5-72B-Instruct')
  await expect(cards.filter({ hasText: 'Qwen 2.5' })).toContainText('MMLU-Pro 71.1')
  await expect(cards.filter({ hasText: 'Qwen 2.5' }).getByRole('link', { name: 'Source' })).toHaveAttribute('href', 'https://arxiv.org/abs/2412.15115')
  await expect(cards.filter({ hasText: 'Llama 3.3' })).toBeVisible()
  await filters.getByRole('button', { name: /Commercial/ }).click()
  await expect(cards).toHaveCount(2)
  await expect(cards.filter({ hasText: 'Mistral Large' })).toContainText('32K tokens')
  await filters.getByRole('button', { name: /All/ }).click()
  await expect(cards.filter({ hasText: 'POC demo model' })).toContainText('Demo')
})
