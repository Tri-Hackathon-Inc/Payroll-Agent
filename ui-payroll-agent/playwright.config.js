import { defineConfig } from '@playwright/test'
import { basePath } from './vite.config.js'

// Same mount path the app uses; run with STUDIO_BASE_PATH=/other/path/ to test another mount.
const BASE = basePath(process.env.STUDIO_BASE_PATH || '/ai_studio/')

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.js',
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:5180', trace: 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {},
  },
  webServer: {
    command: 'npm run dev -- --host 127.0.0.1 --port 5180 --strictPort',
    url: `http://127.0.0.1:5180${BASE}`,
    env: { GRAPHQL_MODE: process.env.GRAPHQL_MODE || 'mock', STUDIO_BASE_PATH: BASE },
    reuseExistingServer: false,
  },
})
