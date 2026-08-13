import { createCollection, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

import { CatalystSchema } from '../domain/catalyst'
import { updateCandleSeries, type CandlePoint } from '../domain/candle'
import {
  DXLINK_REMOVE_EVENT,
  DXLINK_SNAPSHOT_BEGIN,
  DXLINK_SNAPSHOT_END,
  DXLINK_SNAPSHOT_SNIP,
  DXLINK_TX_PENDING,
  LiveMarketEventSchema,
  type LiveMarketEvent,
} from '../server/market-feed-contracts'
import {
  MarketSnapshotSchema,
  ResearchBriefSchema,
  TickerSchema,
  WatchlistSchema,
  type MarketSnapshot,
} from '../domain/market'
import { demoSnapshot } from '../domain/demo'

export const OFFLINE_SNAPSHOT_VERSION = 2
export const MAX_LIVE_MARKET_SYMBOLS = 100

const SyncStateSchema = z.object({
  id: z.literal('snapshot'),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  schemaVersion: z.literal(OFFLINE_SNAPSHOT_VERSION),
  source: z.enum(['demo', 'tastytrade']),
  syncedAt: z.string(),
})

const LegacySyncStateSchema = SyncStateSchema.omit({ schemaVersion: true })
const LegacyTickerSchema = TickerSchema.omit({ sparkline: true }).extend({
  sparkline: z.array(z.number().finite().nonnegative()).min(1),
})
const StoredCollectionSchema = z.record(z.string(), z.object({
  data: z.unknown(),
  versionKey: z.string(),
}))

const PreferenceSchema = z.object({
  id: z.literal('primary'),
  selectedSymbol: z.string(),
  selectedWatchlistId: z.string(),
})

export type SyncState = z.infer<typeof SyncStateSchema>
export type Preference = z.infer<typeof PreferenceSchema>

type SnapshotCollectionName = 'catalysts' | 'research' | 'sync-state' | 'tickers' | 'watchlists'

function snapshotStorageKey(name: SnapshotCollectionName, version = OFFLINE_SNAPSHOT_VERSION): string {
  return `spice.${name}.v${version}`
}

export const tickerCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-tickers',
    storageKey: snapshotStorageKey('tickers'),
    schema: TickerSchema,
    getKey: (ticker) => ticker.symbol,
    startSync: true,
  }),
)

export const watchlistCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-watchlists',
    storageKey: snapshotStorageKey('watchlists'),
    schema: WatchlistSchema,
    getKey: (watchlist) => watchlist.id,
    startSync: true,
  }),
)

export const researchCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-research',
    storageKey: snapshotStorageKey('research'),
    schema: ResearchBriefSchema,
    getKey: (brief) => brief.id,
    startSync: true,
  }),
)

export const catalystCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-catalysts',
    storageKey: snapshotStorageKey('catalysts'),
    schema: CatalystSchema,
    getKey: (catalyst) => catalyst.id,
    startSync: true,
  }),
)

export const syncStateCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-sync-state',
    storageKey: snapshotStorageKey('sync-state'),
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
  delete: (key: TKey) => PersistedMutation
  get: (key: TKey) => T | undefined
  insert: (value: T) => PersistedMutation
  keys: () => IterableIterator<TKey>
  update: (key: TKey, callback: (draft: T) => void) => PersistedMutation
}

type PersistedMutation = { isPersisted: { promise: Promise<unknown> } }
type StorageReader = Pick<Storage, 'getItem'>

function storedRows(storage: StorageReader, key: string): unknown[] | undefined {
  try {
    const serialized = storage.getItem(key)
    if (serialized === null) return undefined
    const parsed = StoredCollectionSchema.safeParse(JSON.parse(serialized))
    return parsed.success ? Object.values(parsed.data).map((item) => item.data) : undefined
  } catch {
    return undefined
  }
}

function parsedStoredRows<T>(
  storage: StorageReader,
  key: string,
  schema: z.ZodType<T>,
): T[] | undefined {
  const rows = storedRows(storage, key)
  if (!rows) return undefined
  const parsed = z.array(schema).safeParse(rows)
  return parsed.success ? parsed.data : undefined
}

function migrateLegacyTicker(ticker: z.infer<typeof LegacyTickerSchema>): z.infer<typeof TickerSchema> | undefined {
  const endTime = Date.parse(ticker.updatedAt)
  const historySpan = (ticker.sparkline.length - 1) * 5 * 60 * 1_000
  if (!Number.isFinite(endTime) || endTime < historySpan) return undefined
  return {
    ...ticker,
    sparkline: ticker.sparkline.map((close, index) => ({
      close,
      sequence: 0,
      time: endTime - (ticker.sparkline.length - index - 1) * 5 * 60 * 1_000,
    })),
  }
}

/** Convert the last coherent v1 snapshot without coupling the app to an empty-row heuristic. */
export function legacySnapshotFromStorage(
  storage: StorageReader,
  demoRuntime: boolean,
): MarketSnapshot | undefined {
  const syncStates = parsedStoredRows(storage, snapshotStorageKey('sync-state', 1), LegacySyncStateSchema)
  const state = syncStates?.find((candidate) => candidate.id === 'snapshot')
  if (!state || (!demoRuntime && state.source === 'demo')) return undefined

  const legacyTickers = parsedStoredRows(storage, snapshotStorageKey('tickers', 1), LegacyTickerSchema)
  const migratedLegacyTickers = legacyTickers?.map(migrateLegacyTicker)
  const currentTickers = parsedStoredRows(storage, snapshotStorageKey('tickers'), TickerSchema)
  const tickers = migratedLegacyTickers?.every((ticker): ticker is z.infer<typeof TickerSchema> => ticker !== undefined)
    ? migratedLegacyTickers
    : currentTickers
  const watchlists = parsedStoredRows(storage, snapshotStorageKey('watchlists', 1), WatchlistSchema)
  const catalysts = parsedStoredRows(storage, snapshotStorageKey('catalysts', 1), CatalystSchema)
  const research = parsedStoredRows(storage, snapshotStorageKey('research', 1), ResearchBriefSchema)
  if (!tickers || !watchlists || !catalysts || research?.length !== 1) return undefined

  const snapshot = MarketSnapshotSchema.safeParse({
    catalysts,
    marketState: state.marketState,
    research: research[0],
    source: state.source,
    syncedAt: state.syncedAt,
    tickers,
    watchlists,
  })
  return snapshot.success ? snapshot.data : undefined
}

export function isSnapshotInitialized(state: SyncState | undefined, demoRuntime: boolean): boolean {
  return Boolean(state && (demoRuntime || state.source === 'tastytrade'))
}

export function selectLiveMarketSymbols(
  selectedSymbol: string | undefined,
  watchlistSymbols: readonly string[],
  loadedSymbols: Iterable<string>,
): string[] {
  const loaded = new Set(loadedSymbols)
  return [...new Set([...(selectedSymbol ? [selectedSymbol] : []), ...watchlistSymbols])]
    .filter((symbol) => loaded.has(symbol))
    .slice(0, MAX_LIVE_MARKET_SYMBOLS)
}

async function replaceRows<T extends object, TKey extends string>(
  collection: MutableCollection<T, TKey>,
  rows: readonly T[],
  getKey: (row: T) => TKey,
): Promise<void> {
  const mutations: PersistedMutation[] = []
  const incoming = new Set(rows.map(getKey))
  for (const key of collection.keys()) {
    if (!incoming.has(key)) mutations.push(collection.delete(key))
  }
  for (const row of rows) {
    const key = getKey(row)
    if (collection.get(key)) {
      mutations.push(collection.update(key, (draft) => Object.assign(draft, row)))
    } else {
      mutations.push(collection.insert(row))
    }
  }
  await Promise.all(mutations.map((mutation) => mutation.isPersisted.promise))
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

  await Promise.all([
    replaceRows(tickerCollection, snapshot.tickers, (ticker) => ticker.symbol),
    replaceRows(watchlistCollection, snapshot.watchlists, (watchlist) => watchlist.id),
    replaceRows(catalystCollection, snapshot.catalysts, (catalyst) => catalyst.id),
    replaceRows(researchCollection, [snapshot.research], (brief) => brief.id),
  ])

  if (!preferenceCollection.get('primary')) {
    const preference = preferenceCollection.insert({
      id: 'primary',
      selectedSymbol: snapshot.tickers[0]?.symbol ?? 'SPY',
      selectedWatchlistId: snapshot.watchlists[0]?.id ?? 'private-core',
    })
    await preference.isPersisted.promise
  }

  const syncState: SyncState = {
    id: 'snapshot',
    marketState: snapshot.marketState,
    schemaVersion: OFFLINE_SNAPSHOT_VERSION,
    source: snapshot.source,
    syncedAt: snapshot.syncedAt,
  }
  const marker = syncStateCollection.get('snapshot')
    ? syncStateCollection.update('snapshot', (draft) => Object.assign(draft, syncState))
    : syncStateCollection.insert(syncState)
  await marker.isPersisted.promise
}

export async function ensureOfflineSnapshot({
  demoRuntime,
  storage,
}: {
  demoRuntime: boolean
  storage?: StorageReader
}) {
  await Promise.all([
    tickerCollection.preload(),
    watchlistCollection.preload(),
    catalystCollection.preload(),
    researchCollection.preload(),
    syncStateCollection.preload(),
  ])
  const current = syncStateCollection.get('snapshot')
  if (isSnapshotInitialized(current, demoRuntime)) return current

  const legacy = storage ? legacySnapshotFromStorage(storage, demoRuntime) : undefined
  if (legacy) {
    await hydrateCollections(legacy)
    return syncStateCollection.get('snapshot')
  }
  if (!demoRuntime) return undefined

  await hydrateCollections(demoSnapshot())
  return syncStateCollection.get('snapshot')
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

type PendingCandleSnapshot = { endSeen: boolean; points: CandlePoint[] }
const pendingCandleSnapshots = new Map<string, PendingCandleSnapshot>()

export function applyLiveMarketEvent(untrusted: unknown): void {
  const parsed = LiveMarketEventSchema.safeParse(untrusted)
  if (!parsed.success || !tickerCollection.get(parsed.data.symbol)) return
  const event: LiveMarketEvent = parsed.data
  tickerCollection.update(event.symbol, (ticker) => {
    const eventAt = Date.parse(event.timestamp)
    const tickerAt = Date.parse(ticker.updatedAt)
    const hasMarketPrice = event.price !== undefined || event.change !== undefined
    if (hasMarketPrice && eventAt >= tickerAt) {
      const priorClose = ticker.price - ticker.change
      if (event.price !== undefined) ticker.price = event.price
      if (event.change !== undefined) ticker.change = event.change
      else if (event.price !== undefined && priorClose > 0) ticker.change = event.price - priorClose
      const referenceClose = event.change !== undefined ? ticker.price - ticker.change : priorClose
      if (referenceClose > 0) ticker.changePercent = (ticker.change / referenceClose) * 100
      ticker.updatedAt = event.timestamp
    }
    if (event.candleSnapshot?.length) {
      pendingCandleSnapshots.delete(event.symbol)
      ticker.sparkline = event.candleSnapshot
    }
    if (event.candle) {
      const { eventFlags, ...point } = event.candle
      if (eventFlags & DXLINK_SNAPSHOT_BEGIN) {
        pendingCandleSnapshots.set(event.symbol, { endSeen: false, points: [] })
      }
      const pending = pendingCandleSnapshots.get(event.symbol)
      if (pending) {
        pending.points = updateCandleSeries(
          pending.points,
          point,
          Boolean(eventFlags & DXLINK_REMOVE_EVENT),
        )
        pending.endSeen ||= Boolean(eventFlags & (DXLINK_SNAPSHOT_END | DXLINK_SNAPSHOT_SNIP))
        if (pending.endSeen && !(eventFlags & DXLINK_TX_PENDING)) {
          if (pending.points.length) ticker.sparkline = pending.points
          pendingCandleSnapshots.delete(event.symbol)
        }
      } else {
        ticker.sparkline = updateCandleSeries(
          ticker.sparkline,
          point,
          Boolean(eventFlags & DXLINK_REMOVE_EVENT),
        )
      }
    }
  })
}
