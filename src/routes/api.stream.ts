import { createFileRoute } from '@tanstack/react-router'

import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest } from '../server/http'
import { isSameOriginWebSocketRequest, parseRequestedSymbols } from '../server/market-feed-contracts'

export const Route = createFileRoute('/api/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await authorizePersonalRequest(request, appEnv)
        if (unauthorized) return unauthorized
        if (!isSameOriginWebSocketRequest(request)) {
          return new Response('Cross-origin WebSocket rejected', { status: 403 })
        }
        if (!appEnv.MARKET_FEED) return new Response('Live market feed unavailable', { status: 503 })
        const url = new URL(request.url)
        const symbols = parseRequestedSymbols(url)
        if (!symbols.length) return new Response('At least one valid symbol is required', { status: 400 })
        url.searchParams.set('symbols', symbols.join(','))
        return appEnv.MARKET_FEED.get(appEnv.MARKET_FEED.idFromName('primary-account')).fetch(new Request(url, request))
      },
    },
  },
})
