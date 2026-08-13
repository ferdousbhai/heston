import { createCollection, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

import { CatalystSchema } from '../domain/catalyst'
import { LiveMarketEventSchema, type LiveMarketEvent } from '../server/market-feed-contracts'
import {
  MarketSnapshotSchema,
  ResearchBriefSchema,
  TickerSchema,
  WatchlistSchema,
  type MarketSnapshot,
} from '../domain/market'
import { demoSnapshot } from '../domain/demo'

const SyncStateSchema = z.object({
  id: z.literal('snapshot'),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  source: z.enum(['demo', 'tastytrade']),
  syncedAt: z.string(),
})

const PreferenceSchema = z.object({
  id: z.literal('primary'),
  selectedSymbol: z.string(),
  selectedWatchlistId: z.string(),
})

export type SyncState = z.infer<typeof SyncStateSchema>
export type Preference = z.infer<typeof PreferenceSchema>

export const tickerCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-tickers',
    storageKey: 'spice.tickers.v1',
    schema: TickerSchema,
    getKey: (ticker) => ticker.symbol,
    startSync: true,
  }),
)

export const watchlistCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-watchlists',
    storageKey: 'spice.watchlists.v1',
    schema: WatchlistSchema,
    getKey: (watchlist) => watchlist.id,
    startSync: true,
  }),
)

export const researchCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-research',
    storageKey: 'spice.research.v1',
    schema: ResearchBriefSchema,
    getKey: (brief) => brief.id,
    startSync: true,
  }),
)

export const catalystCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-catalysts',
    storageKey: 'spice.catalysts.v1',
    schema: CatalystSchema,
    getKey: (catalyst) => catalyst.id,
    startSync: true,
  }),
)

export const syncStateCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-sync-state',
    storageKey: 'spice.sync-state.v1',
    schema: SyncStateSchema,
    getKey: (state) => state.id,
    startSync: true,
  }),
)

export const preferenceCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-preferences',
    storageKey: 'spice.preferences.v1',
    schema: PreferenceSchema,
    getKey: (preference) => preference.id,
    startSync: true,
  }),
)

type MutableCollection<T extends object, TKey extends string> = {
  delete: (key: TKey) => unknown
  get: (key: TKey) => T | undefined
  insert: (value: T) => unknown
  keys: () => IterableIterator<TKey>
  update: (key: TKey, callback: (draft: T) => void) => unknown
}

function replaceRows<T extends object, TKey extends string>(
  collection: MutableCollection<T, TKey>,
  rows: readonly T[],
  getKey: (row: T) => TKey,
) {
  const incoming = new Set(rows.map(getKey))
  for (const key of collection.keys()) {
    if (!incoming.has(key)) collection.delete(key)
  }
  for (const row of rows) {
    const key = getKey(row)
    if (collection.get(key)) {
      collection.update(key, (draft) => Object.assign(draft, row))
    } else {
      collection.insert(row)
    }
  }
}

export async function hydrateCollections(snapshot: MarketSnapshot) {
  await Promise.all([
    tickerCollection.preload(),
    watchlistCollection.preload(),
    catalystCollection.preload(),
    researchCollection.preload(),
    syncStateCollection.preload(),
    preferenceCollection.preload(),
  ])

  replaceRows(tickerCollection, snapshot.tickers, (ticker) => ticker.symbol)
  replaceRows(watchlistCollection, snapshot.watchlists, (watchlist) => watchlist.id)
  replaceRows(catalystCollection, snapshot.catalysts, (catalyst) => catalyst.id)
  replaceRows(researchCollection, [snapshot.research], (brief) => brief.id)
  const syncState: SyncState = {
    id: 'snapshot',
    marketState: snapshot.marketState,
    source: snapshot.source,
    syncedAt: snapshot.syncedAt,
  }
  if (syncStateCollection.get('snapshot')) {
    syncStateCollection.update('snapshot', (draft) => Object.assign(draft, syncState))
  } else {
    syncStateCollection.insert(syncState)
  }

  if (!preferenceCollection.get('primary')) {
    preferenceCollection.insert({
      id: 'primary',
      selectedSymbol: snapshot.tickers[0]?.symbol ?? 'SPY',
      selectedWatchlistId: snapshot.watchlists[0]?.id ?? 'private-core',
    })
  }
}

export async function ensureOfflineSnapshot() {
  await Promise.all([
    tickerCollection.preload(),
    watchlistCollection.preload(),
    catalystCollection.preload(),
  ])
  if (tickerCollection.size === 0 || watchlistCollection.size === 0 || catalystCollection.size === 0) {
    await hydrateCollections(demoSnapshot())
  }
}

export async function syncFromCloud(signal?: AbortSignal): Promise<MarketSnapshot> {
  const response = await fetch('/api/snapshot', {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Snapshot sync failed (${response.status})`)
  const snapshot = MarketSnapshotSchema.parse(await response.json())
  await hydrateCollections(snapshot)
  return snapshot
}

export function selectTicker(symbol: string) {
  const current = preferenceCollection.get('primary')
  if (!current) return
  preferenceCollection.update('primary', (draft) => {
    draft.selectedSymbol = symbol
  })
}

export function selectWatchlist(id: string, fallbackSymbol?: string) {
  const current = preferenceCollection.get('primary')
  if (!current) return
  preferenceCollection.update('primary', (draft) => {
    draft.selectedWatchlistId = id
    if (fallbackSymbol) draft.selectedSymbol = fallbackSymbol
  })
}

export function applyLiveMarketEvent(untrusted: unknown): void {
  const parsed = LiveMarketEventSchema.safeParse(untrusted)
  if (!parsed.success || !tickerCollection.get(parsed.data.symbol)) return
  const event: LiveMarketEvent = parsed.data
  tickerCollection.update(event.symbol, (ticker) => {
    const price = event.price ?? event.candleClose
    if (price !== undefined) ticker.price = price
    if (event.change !== undefined) {
      ticker.change = event.change
      const previousClose = ticker.price - event.change
      if (previousClose > 0) ticker.changePercent = (event.change / previousClose) * 100
    }
    if (event.candleClose !== undefined) {
      const points = [...ticker.sparkline, event.candleClose]
      ticker.sparkline = points.slice(Math.max(0, points.length - 48))
    }
    ticker.updatedAt = event.timestamp
  })
}
