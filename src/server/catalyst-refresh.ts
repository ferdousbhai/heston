import { z } from 'zod'

import { EquitySymbolSchema, isTradeableInstrument } from '../domain/instrument'
import { type Catalyst } from '../domain/catalyst'
import { type CatalystProvider, persistResearchCatalysts } from './catalysts'
import { runExaCatalystSearch } from './catalyst-research-exa'
import { type AppEnv } from './env'
import { readInstrumentCatalog } from './instrument-catalog'

/**
 * Catalyst coverage follows attention: a symbol is worth paying a web search for once a
 * reader favorites it, or once one looks at it and finds an empty near-term calendar.
 * A symbol is searched at most once in this window whatever the search found, so a name
 * nobody has looked at stays unsearched and a name a hundred readers open is one search.
 *
 * The window bounds how often one symbol is searched. It says nothing about how many symbols
 * are reachable, and that set was the whole instrument catalog -- thousands of names, spendable
 * by anyone with no credential, since attention has always been anonymous. Incidental attention
 * is therefore limited to the tracked watchlist: the universe this product actually serves, and
 * already bounded at `MAX_WATCHLIST_SYMBOLS`. Nothing legitimate loses coverage, because a name
 * reaches a reader by being on that list, and a searched name joins it before anyone can look at
 * its calendar. The owner's forced run is unaffected -- it is deliberate rather than incidental,
 * and already costs an owner credential.
 */
export const CATALYST_REFRESH_INTERVAL_DAYS = 30
const CATALYST_PROVIDER: CatalystProvider = 'exa'
const MAX_RUN_DETAIL_LENGTH = 500

const StoredRunSchema = z.object({ ran_at: z.string() })

export type CatalystRefresh = {
  /** What this run bound, so a caller can show it without waiting for the next snapshot. */
  catalysts: Catalyst[]
  ran: boolean
  reason?: 'fresh' | 'unknown-symbol' | 'untracked'
}

/**
 * Claim the run before making it. A concurrent favorite of the same symbol then sees a
 * fresh receipt and does not buy a second search; a run that dies mid-flight leaves a
 * receipt that ages out on its own rather than a lock nothing releases.
 */
async function claimRun(env: AppEnv, symbol: string, now: Date, forced: boolean): Promise<boolean> {
  if (!env.DB) throw new Error('CatalystRunStoreUnavailable')
  const stored = forced ? undefined : await env.DB.prepare(
    'SELECT ran_at FROM catalyst_runs WHERE symbol = ? AND source_provider = ?',
  ).bind(symbol, CATALYST_PROVIDER).first()
  if (stored) {
    // A receipt whose timestamp will not parse reads as expired — the comparison is false for
    // NaN — because one extra search costs less than a symbol that can never be searched again.
    const ranAt = Date.parse(StoredRunSchema.parse(stored).ran_at)
    if (now.getTime() - ranAt < CATALYST_REFRESH_INTERVAL_DAYS * 86_400_000) return false
  }
  await env.DB.prepare(
    `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
     VALUES (?, ?, ?, 0, 'running')
     ON CONFLICT(symbol, source_provider) DO UPDATE SET
       ran_at = excluded.ran_at, catalyst_count = 0, status = 'running', detail = NULL`,
  ).bind(symbol, CATALYST_PROVIDER, now.toISOString()).run()
  return true
}

/**
 * On the maintained watchlist. Searching for a name admits it there, so this is a bound on which
 * symbols incidental attention may spend a search on, not on which symbols can ever be covered.
 */
async function isTracked(env: AppEnv, symbol: string): Promise<boolean> {
  if (!env.DB) return false
  const row = await env.DB.prepare(
    'SELECT 1 AS tracked FROM internal_watchlist_items WHERE symbol = ?',
  ).bind(symbol).first()
  return row !== null
}

async function recordRun(
  env: AppEnv,
  symbol: string,
  status: 'complete' | 'failed',
  catalystCount: number,
  detail: string | undefined,
): Promise<void> {
  if (!env.DB) return
  await env.DB.prepare(
    `UPDATE catalyst_runs SET status = ?, catalyst_count = ?, detail = ?
     WHERE symbol = ? AND source_provider = ?`,
  ).bind(
    status,
    catalystCount,
    detail?.slice(0, MAX_RUN_DETAIL_LENGTH) ?? null,
    symbol,
    CATALYST_PROVIDER,
  ).run()
}

/**
 * Run a catalyst search for one symbol unless one was already run for it inside the refresh
 * window. The symbol must be a resolved instrument this Worker already knows, so attention
 * paid to something the catalog cannot name buys nothing.
 *
 * `forced` spends a search the window would have refused. Incidental attention must stay
 * bounded, but an owner asking on purpose is a different signal, and without it a symbol
 * searched once reads as empty for a month with no way to ask again. The receipt is still
 * written, so a forced run resets the window for everyone rather than escaping it.
 */
export async function refreshCatalystsForSymbol(
  env: AppEnv,
  untrustedSymbol: string,
  now = new Date(),
  forced = false,
): Promise<CatalystRefresh> {
  const symbol = EquitySymbolSchema.parse(untrustedSymbol)
  const instrument = (await readInstrumentCatalog(env, [symbol])).get(symbol)
  // A delisted name has no upcoming anything. Paying for a search on one is spending real money
  // to learn that a company acquired two years ago has no next earnings date.
  if (!instrument || !isTradeableInstrument(instrument)) {
    return { catalysts: [], ran: false, reason: 'unknown-symbol' }
  }
  if (!forced && !await isTracked(env, symbol)) {
    return { catalysts: [], ran: false, reason: 'untracked' }
  }
  if (!await claimRun(env, symbol, now, forced)) return { catalysts: [], ran: false, reason: 'fresh' }

  try {
    const run = await runExaCatalystSearch(
      env,
      symbol,
      instrument.description ?? instrument.shortDescription ?? symbol,
      now,
    )
    await persistResearchCatalysts(env, CATALYST_PROVIDER, run.catalysts, now)
    await recordRun(env, symbol, 'complete', run.catalysts.length, run.rejected.join('; ') || undefined)
    return { catalysts: run.catalysts, ran: true }
  } catch (error) {
    const cause = error instanceof Error ? error.message : 'UnknownError'
    console.error('CatalystRefreshFailed', symbol, cause)
    await recordRun(env, symbol, 'failed', 0, cause)
    return { catalysts: [], ran: true }
  }
}
