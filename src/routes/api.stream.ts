import { createFileRoute } from '@tanstack/react-router'

import { appEnv } from '../server/worker-env'
import { isSameOriginWebSocketRequest, parseRequestedSymbols } from '../server/market-feed-contracts'

/**
 * Same-origin browsers, signed in or not, share one Durable Object. That object holds the
 * only dxLink socket. The quote token never leaves Cloudflare.
 */
export const Route = createFileRoute('/api/stream')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isSameOriginWebSocketRequest(request)) {
          return new Response('Cross-origin WebSocket rejected', { status: 403 })
        }
        if (!appEnv.MARKET_FEED) return new Response('Live market feed unavailable', { status: 503 })
        const url = new URL(request.url)
        let symbols: string[]
        try {
          symbols = parseRequestedSymbols(url)
        } catch {
          return new Response('Invalid market feed subscription', { status: 400 })
        }
        url.searchParams.set('symbols', symbols.join(','))
        return appEnv.MARKET_FEED.get(appEnv.MARKET_FEED.idFromName('primary-account')).fetch(new Request(url, request))
      },
    },
  },
})
