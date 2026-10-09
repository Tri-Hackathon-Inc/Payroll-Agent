import { test, expect } from '@playwright/test'
import { basePath } from '../scripts/settings.mjs'

test.skip(!process.env.AGENT_RUNTIME_DEV, 'Checks the Angular development server host allowlist.')
const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')

test('serves runtime templates to the Docker proxy hostname and rejects unknown hosts', async ({ request }) => {
  const headers = { Host: 'ui:5173' }
  const manifestUrl = `http://127.0.0.1:5182${BASE}ui-templates/manifest.json`
  const response = await request.get(manifestUrl, { headers })
  expect(response.status()).toBe(200)
  const manifest = await response.json()
  const entry = new URL(manifest.templates.find(item => item.page === 'payrun').entry, manifestUrl)
  const html = await request.get(entry.href, { headers })
  expect(html.status()).toBe(200)
  const scripts = [...(await html.text()).matchAll(/<script[^>]+src="([^"]+)"/g)]
  expect(scripts.length).toBeGreaterThan(0)
  for (const [, src] of scripts) expect((await request.get(new URL(src, entry).href, { headers })).status()).toBe(200)

  const blocked = await request.get(manifestUrl, { headers: { Host: 'unrelated.example:5173' } })
  expect(blocked.status()).toBe(403)
})
