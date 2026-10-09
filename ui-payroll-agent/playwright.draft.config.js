import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './tests', testMatch: ['**/draft-preview.spec.js', '**/anomaly-review.spec.js'], workers: 1, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:5181', trace: 'retain-on-failure' },
  webServer: {
    command: `"${process.execPath}" tests/serve-payroll-preview.mjs`,
    url: 'http://127.0.0.1:5181/trinet/', reuseExistingServer: false,
  },
})
