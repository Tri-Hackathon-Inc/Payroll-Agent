import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests', testMatch: ['access-control.spec.js', 'agent-delete.spec.js', 'agent-health.spec.js'], workers: 1, timeout: 60000,
  use: { trace: 'retain-on-failure', launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {} },
})
