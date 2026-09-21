import { defineConfig, devices } from '@playwright/test'

const e2ePort = process.env.HESTON_E2E_PORT ?? '3000'
const e2eBaseUrl = `http://localhost:${e2ePort}`
// The identity check reads this rather than the config, so it holds whichever order Playwright
// runs global setup and the web server in.
process.env.HESTON_E2E_BASE_URL = e2eBaseUrl

export default defineConfig({
  testDir: './test',
  globalSetup: './test/e2e-server-identity.ts',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: e2eBaseUrl,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${e2ePort}`,
    url: `${e2eBaseUrl}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
