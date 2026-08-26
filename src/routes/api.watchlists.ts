import { createFileRoute } from '@tanstack/react-router'

import { toError } from '../domain/failure'

import { WatchlistMutationSchema } from '../domain/watchlist'
import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, publicError } from '../server/http'
import { executeWatchlistAction } from '../server/watchlist-actions'

export const Route = createFileRoute('/api/watchlists')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauthorized = await authorizePersonalRequest(request, appEnv, true)
        if (unauthorized) return unauthorized
        const parsed = WatchlistMutationSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid watchlist change' }, { status: 400 })
        try {
          return jsonNoStore(await executeWatchlistAction(appEnv, parsed.data))
        } catch (error) {
          return jsonNoStore({ error: publicError(toError(error)) }, { status: 409 })
        }
      },
    },
  },
})
