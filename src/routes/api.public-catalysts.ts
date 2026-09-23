import { createFileRoute } from '@tanstack/react-router'

import { EquitySymbolSchema } from '../domain/instrument'
import { jsonNoStore, jsonPublic } from '../server/http'
import { readUpcomingCatalystsForSymbol } from '../server/catalysts'
import { appEnv } from '../server/worker-env'

// A staleness budget, not a provider figure. The rows change only when a research run lands,
// and a reader who just bought one drops their in-page copy, but the browser's HTTP cache can
// still answer that refetch: a minute bounds how long the reader waits to see their own search.
// The edge copy is shared by every reader of the symbol, so it may hold twice that.
const CATALYSTS_BROWSER_MAX_AGE_SECONDS = 60
const CATALYSTS_EDGE_MAX_AGE_SECONDS = 2 * CATALYSTS_BROWSER_MAX_AGE_SECONDS

/**
 * Full catalyst rows for one symbol — description and source — for the focused runway.
 * The snapshot only carries the calendar, the same split as year closes vs the year chart.
 */
export const Route = createFileRoute('/api/public-catalysts')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const symbol = new URL(request.url).searchParams.get('symbol')
        const parsed = EquitySymbolSchema.safeParse(symbol)
        if (!parsed.success) return jsonNoStore({ error: 'Unknown symbol' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Catalysts are unavailable' }, { status: 503 })
        try {
          const catalysts = await readUpcomingCatalystsForSymbol(appEnv, parsed.data)
          // Already parsed against `CatalystSchema` by the store read.
          const response = jsonPublic({ catalysts })
          response.headers.set(
            'Cache-Control',
            `public, max-age=${CATALYSTS_BROWSER_MAX_AGE_SECONDS}, s-maxage=${CATALYSTS_EDGE_MAX_AGE_SECONDS}`,
          )
          return response
        } catch (error) {
          console.error('PublicCatalystsUnavailable', error instanceof Error ? error.name : 'UnknownError')
          return jsonNoStore({ error: 'Catalysts are temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
