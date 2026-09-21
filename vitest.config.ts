import { defineConfig } from 'vitest/config'

export default defineConfig({
  define: {
    'import.meta.env.VITE_HESTON_DEPLOYMENT_ID': JSON.stringify('test'),
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
