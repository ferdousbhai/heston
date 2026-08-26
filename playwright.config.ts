import { defineConfig, devices } from '@playwright/test'

const e2ePort = process.env.SPICE_E2E_PORT ?? '3000'
const e2eBaseUrl = `http://localhost:${e2ePort}`

export default defineConfig({
  testDir: './test',
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
