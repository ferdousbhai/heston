import { marketDate } from '../domain/catalyst'
import { type AppEnv } from './env'
import { readInternalWatchlistFocus } from './internal-watchlist'
import { upsertYearCandles } from './year-candle-store'

/**
 * Refresh the cached year of daily closes. A daily bar changes once a session, so this runs on
 * the schedule rather than on the live feed, and the read path serves whatever was last stored.
 * Returning the count keeps the caller's log honest about a partial refresh.
 */
export async function refreshYearCandles(env: AppEnv, asOf = new Date()): Promise<number> {
  if (!env.DB || !env.MARKET_FEED) return 0
  const symbols = await readInternalWatchlistFocus(env, [])
  if (!symbols.length) return 0
  const result = await env.MARKET_FEED.getByName('primary-account').readDailyCandles(symbols)
  const series = new Map(result.series.map(({ symbol, closes }) => [symbol, closes]))
  await upsertYearCandles(env.DB, marketDate(asOf), series)
  return series.size
}
