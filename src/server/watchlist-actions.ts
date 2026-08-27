import { type WatchlistMutation, type WatchlistMutationResult } from '../domain/watchlist'
import { type AppEnv } from './env'
import {
  ensureInternalWatchlistSymbols,
  readInternalWatchlist,
  removeInternalWatchlistSymbols,
} from './internal-watchlist'
import { defineSeam, type SeamValue } from './seam'

export async function executeWatchlistAction(
  env: AppEnv,
  action: WatchlistMutation,
): Promise<WatchlistMutationResult> {
  const symbols = [...new Set(action.symbols)]
  if (action.kind === 'remove_watchlist_symbols') {
    const removed = await removeInternalWatchlistSymbols(env, symbols)
    return {
      appliedSymbols: removed,
      detail: removed.length ? `${removed.join(', ')} removed from Watchlist` : 'No watchlist changes were needed',
      discardedSymbols: [],
    }
  }

  const existing = new Set((await readInternalWatchlist(env)).map((item) => item.symbol))
  // An explicit owner add also promotes a public-seed member into the active
  // working set; immutable broker provenance remains in the seed tables.
  const retained = await ensureInternalWatchlistSymbols(env, symbols, 'owner')
  const retainedSet = new Set(retained)
  const added = symbols.filter((symbol) => !existing.has(symbol) && retainedSet.has(symbol))
  const discarded = symbols.filter((symbol) => !retainedSet.has(symbol))
  return {
    appliedSymbols: retained,
    detail: discarded.length
      ? `${discarded.join(', ')} could not be retained within the 100-symbol Watchlist`
      : added.length
      ? `${added.join(', ')} added to Watchlist`
      : `${symbols.join(', ')} already in Watchlist; priority refreshed`,
    discardedSymbols: discarded,
  }
}

/** A narrow seam keeps direct-action tests faithful without replacing D1 globally. */
const watchlistWriterSeam = defineSeam(() => ({ executeWatchlistAction }))

export type WatchlistWriter = SeamValue<typeof watchlistWriterSeam>

export const watchlistWriter = watchlistWriterSeam.current

export const setWatchlistWriter = watchlistWriterSeam.set

export const resetWatchlistWriter = watchlistWriterSeam.reset
