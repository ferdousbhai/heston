import { type AppEnv } from '../../src/server/env'
import { brokerApi } from '../../src/server/tastytrade'

export type OwnerMarketSyncSummary = {
  catalystCount: number
  syncedAt: string
  tickerCount: number
  watchlistItemCount: number
}

/**
 * The first owner snapshot both the seed and instrument-catalog bootstraps run
 * once their list is authoritative. Only counts and the observation time leave
 * the Worker: source watchlist names, membership, and ticker provenance stay
 * private even on an owner-only route, so the run log can never carry them.
 */
export async function summarizeOwnerMarketSync(env: AppEnv): Promise<OwnerMarketSyncSummary> {
  const snapshot = await brokerApi().loadMarketSnapshot(env)
  const [watchlist] = snapshot.watchlists
  // MarketSnapshotSchema pins this array to exactly one entry; an owner sync reads the
  // brokerage's private list, so a public one here is a broken assumption to surface,
  // never a 0 that looks like an empty watchlist.
  if (watchlist.kind !== 'private') throw new Error('OwnerMarketSync:watchlist-not-private')
  return {
    catalystCount: snapshot.catalysts.length,
    syncedAt: snapshot.syncedAt,
    tickerCount: snapshot.tickers.length,
    watchlistItemCount: watchlist.symbols.length,
  }
}
