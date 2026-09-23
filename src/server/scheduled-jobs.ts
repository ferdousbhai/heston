import { marketDate } from '../domain/catalyst'
import { isRegularSessionOpen } from '../domain/market'
import { type AppEnv } from './env'
import { readInternalWatchlistFocus } from './internal-watchlist'
import { MARKET_FEED_INSTANCE, MAX_DAILY_CANDLE_SYMBOLS } from './market-feed-contracts'
import { replaceYearCandles } from './year-candle-store'

/**
 * Refresh the cached year of daily closes. A daily bar changes once a session, so this runs on
 * the schedule rather than on the live feed, and the read path serves whatever was last stored.
 * Returning the count keeps the caller's log honest about a partial refresh.
 */
export async function refreshYearCandles(env: AppEnv, asOf = new Date()): Promise<number> {
  // The trigger fires at 13:30 and 14:30 UTC so one of them is 09:30 Eastern in either DST
  // offset. The off-season fire is a no-op rather than a second DXLink subscription.
  if (!isRegularSessionOpen(asOf)) return 0
  if (!env.DB || !env.MARKET_FEED) return 0
  // The focus defaults to the watchlist's own `MAX_WATCHLIST_SYMBOLS`, but one year read admits
  // only `MAX_DAILY_CANDLE_SYMBOLS`. Asking for the list's bound refused the whole refresh the
  // moment the list — which grows on its own through visitor search — outgrew the read. The
  // focus is priority-ordered, so the read's budget goes to the names ranked first, and the
  // replace below retires the rows of every name that fell out of that budget.
  const symbols = await readInternalWatchlistFocus(env, [], MAX_DAILY_CANDLE_SYMBOLS)
  if (!symbols.length) return 0
  const result = await env.MARKET_FEED.getByName(MARKET_FEED_INSTANCE).readDailyCandles(symbols)
  const series = new Map(result.series.map(({ symbol, closes }) => [symbol, closes]))
  await replaceYearCandles(env.DB, marketDate(asOf), symbols, series)
  return series.size
}
