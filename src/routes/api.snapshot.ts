import { createFileRoute } from '@tanstack/react-router'

import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore } from '../server/http'
import { brokerApi } from '../server/tastytrade'

export const Route = createFileRoute('/api/snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await authorizePersonalRequest(request, appEnv)
        if (unauthorized) return unauthorized
        try {
          return jsonNoStore(await brokerApi().loadMarketSnapshot(appEnv))
        } catch (error) {
          console.error('MarketSnapshotUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Market sync is temporarily unavailable' }, { status: 502 })
        }
      },
    },
  },
})
