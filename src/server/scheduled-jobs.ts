import { marketDate } from '../domain/catalyst'
import { isRegularSessionOpen } from '../domain/market'
import { type AppEnv } from './env'
import { readInternalWatchlistFocus } from './internal-watchlist'
import { MARKET_FEED_INSTANCE, MAX_DAILY_CANDLE_SYMBOLS } from './market-feed-contracts'
import { ConfigurationError } from './secrets'
import { replaceYearCandles } from './year-candle-store'

/**
 * What one tick's year refresh did. The off-hour fire is its own outcome rather than a count of
 * zero, because a refresh that ran and stored nothing -- an empty focus, a feed that answered for
 * no symbol -- is worth noticing, and a skip that logs the same line would hide it every day.
 */
export type YearCandleRefresh =
  | { status: 'refreshed'; symbolCount: number }
  | { reason: 'session-closed'; status: 'skipped' }

/** The tick's log line for a refresh: an event name and a count, never symbols or content. */
export function yearCandleRefreshEvent(refresh: YearCandleRefresh) {
  return refresh.status === 'skipped'
    ? { event: 'YearCandlesRefreshSkipped', reason: refresh.reason }
    : { event: 'YearCandlesRefreshed', symbolCount: refresh.symbolCount }
}

/**
 * Refresh the cached year of daily closes. A daily bar changes once a session, so this runs on
 * the schedule rather than on the live feed, and the read path serves whatever was last stored.
 * Returning the count keeps the caller's log honest about a partial refresh.
 */
export async function refreshYearCandles(env: AppEnv, asOf = new Date()): Promise<YearCandleRefresh> {
  // The trigger fires at 13:30 and 14:30 UTC so one of them is 09:30 Eastern in either DST
  // offset. The off-season fire is a no-op rather than a second DXLink subscription.
  if (!isRegularSessionOpen(asOf)) return { reason: 'session-closed', status: 'skipped' }
  // A missing binding is a misconfiguration, not a refresh of nothing: throw its name so the
  // tick's failure log says which one, rather than logging a count of zero that reads as success.
  if (!env.DB) throw new ConfigurationError('BindingMissing', 'DB')
  if (!env.MARKET_FEED) throw new ConfigurationError('BindingMissing', 'MARKET_FEED')
  // The focus defaults to the watchlist's own `MAX_WATCHLIST_SYMBOLS`, but one year read admits
  // only `MAX_DAILY_CANDLE_SYMBOLS`. Asking for the list's bound refused the whole refresh the
  // moment the list — which grows on its own through visitor search — outgrew the read. The
  // focus is priority-ordered, so the read's budget goes to the names ranked first, and the
  // replace below retires the rows of every name that fell out of that budget.
  const symbols = await readInternalWatchlistFocus(env, [], MAX_DAILY_CANDLE_SYMBOLS)
  if (!symbols.length) return { status: 'refreshed', symbolCount: 0 }
  const result = await env.MARKET_FEED.getByName(MARKET_FEED_INSTANCE).readDailyCandles(symbols)
  const series = new Map(result.series.map(({ symbol, closes }) => [symbol, closes]))
  await replaceYearCandles(env.DB, marketDate(asOf), symbols, series)
  return { status: 'refreshed', symbolCount: series.size }
}
