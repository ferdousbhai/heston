import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { AggregateWatchlistMutationSchema } from '../domain/watchlist'
import { type AppEnv } from '../server/env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import { executeAggregateWatchlistAction } from '../server/watchlist-actions'

export const Route = createFileRoute('/api/watchlists')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv, true)
        if (unauthorized) return unauthorized
        const parsed = AggregateWatchlistMutationSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid watchlist change' }, { status: 400 })
        try {
          return jsonNoStore(await executeAggregateWatchlistAction(workerEnv, parsed.data))
        } catch (error) {
          return jsonNoStore({ error: publicError(error) }, { status: 409 })
        }
      },
    },
  },
})
