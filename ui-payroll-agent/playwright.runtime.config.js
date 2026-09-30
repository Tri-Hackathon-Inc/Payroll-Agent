import { defineConfig } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { basePath } from './scripts/settings.mjs'

const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')
process.env.TRINET_UI_URL = 'http://127.0.0.1:5184/trinet/'

// Exercises published Angular artifacts through the independent host's proxy.
// Run npm run build first, or set AGENT_RUNTIME_DEV=1 to verify development serving.
// All payroll/model responses are local browser fixtures.
export default defineConfig({
  timeout: 60000, testDir: './tests',
  testMatch: ['payroll-scope.spec.js', 'runtime-template.spec.js', 'runtime-hosts.spec.js'], workers: 1,
  use: { trace: 'retain-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {} },
  webServer: [
    { command: `"${process.execPath}" scripts/${process.env.AGENT_RUNTIME_DEV ? 'dev' : 'preview'}.mjs --host 127.0.0.1 --port 5182`,
      timeout: 180000,
      url: `http://127.0.0.1:5182${BASE}`, env: { GRAPHQL_MODE: 'mock', STUDIO_BASE_PATH: BASE }, reuseExistingServer: false },
    { command: `"${process.execPath}" node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5184 --strictPort`,
      cwd: fileURLToPath(new URL('../ui-trinet-mock', import.meta.url)),
      url: process.env.TRINET_UI_URL,
      env: { AGENT_STUDIO_TARGET: `http://127.0.0.1:5182${BASE}` }, reuseExistingServer: false },
  ],
})
