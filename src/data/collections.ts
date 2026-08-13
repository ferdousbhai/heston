import { createCollection, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

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
    researchCollection.preload(),
    syncStateCollection.preload(),
    preferenceCollection.preload(),
  ])

  replaceRows(tickerCollection, snapshot.tickers, (ticker) => ticker.symbol)
  replaceRows(watchlistCollection, snapshot.watchlists, (watchlist) => watchlist.id)
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
  await Promise.all([tickerCollection.preload(), watchlistCollection.preload()])
  if (tickerCollection.size === 0 || watchlistCollection.size === 0) {
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
