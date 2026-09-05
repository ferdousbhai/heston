import { marketDate } from '../domain/catalyst'
import { MAX_LIVE_STREAM_SYMBOLS } from '../domain/watchlist'
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
  // The focus defaults to the watchlist's own 500-symbol bound, but this read is served by a
  // DXLink subscription, which admits `MAX_LIVE_STREAM_SYMBOLS`. Asking for the list's bound
  // instead of the feed's refused the whole refresh the moment the list — which grows on its
  // own through visitor search — passed 100. The focus is priority-ordered, so the feed's
  // budget takes the names the year chart is actually drawn for.
  const symbols = await readInternalWatchlistFocus(env, [], MAX_LIVE_STREAM_SYMBOLS)
  if (!symbols.length) return 0
  const result = await env.MARKET_FEED.getByName('primary-account').readDailyCandles(symbols)
  const series = new Map(result.series.map(({ symbol, closes }) => [symbol, closes]))
  await upsertYearCandles(env.DB, marketDate(asOf), series)
  return series.size
}
