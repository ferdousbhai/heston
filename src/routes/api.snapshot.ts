import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { type AppEnv } from '../server/env'
import { authorizePersonalRequest, jsonNoStore } from '../server/http'
import { loadMarketSnapshot } from '../server/tastytrade'

export const Route = createFileRoute('/api/snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv)
        if (unauthorized) return unauthorized
        try {
          return jsonNoStore(await loadMarketSnapshot(workerEnv))
        } catch {
          return jsonNoStore({ error: 'Market sync is temporarily unavailable' }, { status: 502 })
        }
      },
    },
  },
})
