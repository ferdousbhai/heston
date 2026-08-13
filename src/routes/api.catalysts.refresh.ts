import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { type AppEnv } from '../server/env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import { runXCatalystResearch } from '../server/x-catalysts'

export const Route = createFileRoute('/api/catalysts/refresh')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv, true)
        if (unauthorized) return unauthorized
        try {
          return jsonNoStore(await runXCatalystResearch(workerEnv))
        } catch (error) {
          return jsonNoStore({ error: publicError(error) }, { status: 502 })
        }
      },
    },
  },
})
