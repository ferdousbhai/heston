import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './test',
  testMatch: '**/*.e2e.ts',
  fullyParallel: false,
  reporter: 'line',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'mobile-chromium', use: { ...devices['Pixel 7'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000/api/health',
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
