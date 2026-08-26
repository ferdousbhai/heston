import { type WatchlistMutation } from '../domain/watchlist'
import { type AppEnv } from './env'
import {
  ensureInternalWatchlistSymbols,
  readInternalWatchlist,
  removeInternalWatchlistSymbols,
} from './internal-watchlist'

export async function executeWatchlistAction(
  env: AppEnv,
  action: WatchlistMutation,
): Promise<{ detail: string }> {
  const symbols = [...new Set(action.symbols)]
  if (action.kind === 'remove_watchlist_symbols') {
    const removed = await removeInternalWatchlistSymbols(env, symbols)
    return {
      detail: removed.length ? `${removed.join(', ')} removed from Watchlist` : 'No watchlist changes were needed',
    }
  }

  const existing = new Set((await readInternalWatchlist(env)).map((item) => item.symbol))
  const added = symbols.filter((symbol) => !existing.has(symbol))
  // An explicit owner add also promotes a public-seed member into the active
  // working set; immutable broker provenance remains in the seed tables.
  await ensureInternalWatchlistSymbols(env, symbols, 'owner')
  return {
    detail: added.length
      ? `${added.join(', ')} added to Watchlist`
      : `${symbols.join(', ')} already in Watchlist; priority refreshed`,
  }
}

/** A narrow seam keeps direct-action tests faithful without replacing D1 globally. */
function createWatchlistWriter() {
  return { executeWatchlistAction }
}

export type WatchlistWriter = ReturnType<typeof createWatchlistWriter>

let installedWatchlistWriter: WatchlistWriter = createWatchlistWriter()

export function watchlistWriter(): WatchlistWriter {
  return installedWatchlistWriter
}

export function setWatchlistWriter(next: WatchlistWriter): void {
  installedWatchlistWriter = next
}

export function resetWatchlistWriter(): void {
  installedWatchlistWriter = createWatchlistWriter()
}
