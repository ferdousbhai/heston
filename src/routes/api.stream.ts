import { createFileRoute } from '@tanstack/react-router'
import { env } from 'cloudflare:workers'

import { type AppEnv } from '../server/env'
import { authorizePersonalRequest } from '../server/http'
import { isSameOriginWebSocketRequest, parseRequestedSymbols } from '../server/market-feed-contracts'

export const Route = createFileRoute('/api/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const workerEnv = env as unknown as AppEnv
        const unauthorized = await authorizePersonalRequest(request, workerEnv)
        if (unauthorized) return unauthorized
        if (!isSameOriginWebSocketRequest(request)) {
          return new Response('Cross-origin WebSocket rejected', { status: 403 })
        }
        if (!workerEnv.MARKET_FEED) return new Response('Live market feed unavailable', { status: 503 })
        const url = new URL(request.url)
        const symbols = parseRequestedSymbols(url)
        if (!symbols.length) return new Response('At least one valid symbol is required', { status: 400 })
        url.searchParams.set('symbols', symbols.join(','))
        return workerEnv.MARKET_FEED.get(workerEnv.MARKET_FEED.idFromName('primary-account')).fetch(new Request(url, request))
      },
    },
  },
})
