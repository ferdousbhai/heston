import { randomUUID } from 'node:crypto'
import { defineConfig } from 'vite'

import { tanstackStart } from '@tanstack/react-start/plugin/vite'

import viteReact from '@vitejs/plugin-react'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'

function dataDeploymentId(command: 'build' | 'serve'): string {
  if (command === 'serve') return 'development'
  // Workers Builds supplies a fresh UUID for every build, including a rebuild of the
  // same commit. Local production builds need the same deploy-scoped behavior.
  return process.env.WORKERS_CI_BUILD_UUID?.trim() || randomUUID()
}

const config = defineConfig(({ command }) => ({
  define: {
    'import.meta.env.VITE_SPICE_DEPLOYMENT_ID': JSON.stringify(dataDeploymentId(command)),
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    cloudflare({ viteEnvironment: { name: 'ssr' } }),

    tanstackStart(),
    viteReact(),
  ],
}))

export default config
