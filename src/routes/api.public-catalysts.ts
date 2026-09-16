import { createFileRoute } from '@tanstack/react-router'

import { CatalystSchema } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { jsonNoStore, jsonPublic } from '../server/http'
import { readUpcomingCatalystsForSymbol } from '../server/catalysts'
import { appEnv } from '../server/worker-env'

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
          const response = jsonPublic({ catalysts: CatalystSchema.array().parse(catalysts) })
          response.headers.set('Cache-Control', 'public, max-age=60, s-maxage=120')
          return response
        } catch (error) {
          console.error('PublicCatalystsUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Catalysts are temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
