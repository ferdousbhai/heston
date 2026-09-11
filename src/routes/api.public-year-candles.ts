import { createFileRoute } from '@tanstack/react-router'

import { YearCandlesSchema } from '../domain/market'
import { jsonNoStore, jsonPublic } from '../server/http'
import { appEnv } from '../server/worker-env'
import { readYearCandleSeries } from '../server/year-candle-store'

/**
 * The year series on its own, for the one column that draws it. It changes once a day, which
 * is the argument for a separately cached resource rather than for riding the market snapshot
 * a reader refetches on every tab focus — a year of closes for a hundred symbols dwarfs
 * everything else in that payload, and most screens never render the chart at all.
 *
 * Daily closes are not account-derived, so one public response serves every audience.
 */
export const Route = createFileRoute('/api/public-year-candles')({
  server: {
    handlers: {
      GET: async () => {
        if (!appEnv.DB) return jsonNoStore({ error: 'Year history is unavailable' }, { status: 503 })
        try {
          const { asOf, series } = await readYearCandleSeries(appEnv.DB)
          // The instant is the store's, never the request's: a reader asking when this was
          // refreshed is not asking when they asked.
          const response = jsonPublic(YearCandlesSchema.parse({
            asOf,
            series: [...series].map(([symbol, closes]) => ({ closes, symbol })),
          }))
          // The scheduled refresh writes this once a market day, so the default snapshot
          // freshness would spend a request an hour on an answer that cannot have changed.
          response.headers.set('Cache-Control', 'public, max-age=900, s-maxage=3600')
          return response
        } catch (error) {
          console.error('YearCandlesUnavailable', error instanceof Error ? error.message : 'UnknownError')
          return jsonNoStore({ error: 'Year history is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
