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
  const supplied = process.env.WORKERS_CI_BUILD_UUID?.trim()
  if (supplied) return supplied
  // One build evaluates this config once per environment, and the client and server
  // environments can be separate processes. Minting a UUID per call therefore stamped each
  // bundle with a different id, so every response looked like a newer deployment to the
  // client and the app never loaded. Publishing the first one back into the environment is
  // what makes the whole build agree on a single id.
  process.env.SPICE_BUILD_UUID ||= randomUUID()
  return process.env.SPICE_BUILD_UUID
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
