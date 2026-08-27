import { createCollection, localOnlyCollectionOptions, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

import { CatalystSchema } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { type JsonValue } from '../domain/json-payload'
import { reconcileCandleSeries, updateCandleSeries, type CandlePoint } from '../domain/candle'
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
  type Ticker,
} from '../domain/market'
import { type WatchlistMutation } from '../domain/watchlist'

// Bumped when the persisted snapshot shape changes. v6 drops the derived positions
// list, so stale two-list rows must not be restored into the single-watchlist UI.
export const OFFLINE_SNAPSHOT_VERSION = 6
export const MAX_LIVE_MARKET_SYMBOLS = 100
export type SnapshotAudience = 'owner' | 'public'

const SyncStateSchema = z.object({
  audience: z.enum(['owner', 'public']),
  id: z.literal('snapshot'),
  marketState: z.enum(['open', 'closed', 'pre', 'after', 'unknown']),
  schemaVersion: z.literal(OFFLINE_SNAPSHOT_VERSION),
  source: z.literal('tastytrade'),
  syncedAt: z.string(),
})

const PreferenceSchema = z.object({
  // New anonymous edits get an identity independent of their symbol set. The
  // user-id field remains read-compatible only for preferences written by v2.
  favoriteStageVersion: z.string().uuid().optional(),
  favoriteUserId: z.string().min(1).max(256).optional(),
  id: z.literal('primary'),
  pinnedSymbols: z.array(EquitySymbolSchema).max(MAX_LIVE_MARKET_SYMBOLS).default([]),
  selectedSymbol: z.string(),
  selectedWatchlistId: z.string(),
})

export type Preference = z.infer<typeof PreferenceSchema>
export type SyncState = z.infer<typeof SyncStateSchema>

type SnapshotCollectionName = 'catalysts' | 'research' | 'sync-state' | 'tickers' | 'watchlists'

function snapshotStorageKey(name: SnapshotCollectionName, version = OFFLINE_SNAPSHOT_VERSION): string {
  return `spice.${name}.v${version}`
}

const persistedTickerCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-persisted-tickers',
    storageKey: snapshotStorageKey('tickers'),
    schema: TickerSchema,
    getKey: (ticker) => ticker.symbol,
    startSync: true,
  }),
)

/**
 * The persisted snapshot makes startup cache-first. DXLink ticks stay in this in-memory overlay so
 * mobile browsers are not forced through a synchronous localStorage write for every market event.
 */
export const tickerCollection = createCollection(
  localOnlyCollectionOptions<typeof TickerSchema, string>({
    id: 'spice-live-tickers',
    schema: TickerSchema,
    getKey: (ticker) => ticker.symbol,
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
    storageKey: 'spice.preferences.v2',
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
export function isSnapshotInitialized(state: SyncState | undefined, audience?: SnapshotAudience): boolean {
  return Boolean(state && (!audience || state.audience === audience))
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
  merge: (draft: T, row: T) => void = (draft, row) => Object.assign(draft, row),
): Promise<void> {
  const mutations: PersistedMutation[] = []
  const incoming = new Set(rows.map(getKey))
  // TanStack applies deletes optimistically, so snapshot the iterator before mutating it.
  const existingKeys = Array.from(collection.keys())
  for (const key of existingKeys) {
    if (!incoming.has(key)) mutations.push(collection.delete(key))
  }
  for (const row of rows) {
    const key = getKey(row)
    if (collection.get(key)) {
      mutations.push(collection.update(key, (draft) => merge(draft, row)))
    } else {
      mutations.push(collection.insert(row))
    }
  }
  await Promise.all(mutations.map((mutation) => mutation.isPersisted.promise))
}

async function replaceLiveTickers(
  rows: readonly Ticker[],
  preserveNewerMarketFields = false,
  replaceExisting = false,
): Promise<void> {
  const mutations: PersistedMutation[] = []
  const incoming = new Set(rows.map((ticker) => ticker.symbol))
  const existingKeys = Array.from(tickerCollection.keys())
  for (const key of existingKeys) {
    if (!incoming.has(key)) mutations.push(tickerCollection.delete(key))
  }
  for (const ticker of rows) {
    if (!tickerCollection.get(ticker.symbol)) {
      mutations.push(tickerCollection.insert(ticker))
      continue
    }
    mutations.push(tickerCollection.update(ticker.symbol, (draft) => {
      if (replaceExisting) {
        Object.assign(draft, ticker)
        return
      }
      const sparkline = reconcileCandleSeries(draft.sparkline, ticker.sparkline)
      if (preserveNewerMarketFields && Date.parse(draft.updatedAt) > Date.parse(ticker.updatedAt)) {
        const { change, changePercent, price, updatedAt } = draft
        Object.assign(draft, ticker, { change, changePercent, price, sparkline, updatedAt })
        return
      }
      Object.assign(draft, ticker, { sparkline })
    }))
  }
  await Promise.all(mutations.map((mutation) => mutation.isPersisted.promise))
}

async function hydrateCollectionsImmediately(snapshot: MarketSnapshot, audience: SnapshotAudience) {
  await Promise.all([
    persistedTickerCollection.preload(),
    tickerCollection.preload(),
    watchlistCollection.preload(),
    catalystCollection.preload(),
    researchCollection.preload(),
    syncStateCollection.preload(),
    preferenceCollection.preload(),
  ])

  const previousMarker = syncStateCollection.get('snapshot')
  const audienceChanged = Boolean(previousMarker && previousMarker.audience !== audience)
  if (audienceChanged) {
    // Invalidate the old audience before any rows change. If persistence then fails
    // halfway through, the UI cannot treat a mixed owner/public cache as renderable.
    await syncStateCollection.delete('snapshot').isPersisted.promise
  }
  // The marker can be absent after storage eviction or an interrupted transition. Every
  // public hydrate must therefore scrub owner-only quote and partial-candle state even
  // when there is no previous audience value to compare.
  const scrubLiveOverlay = audience === 'public' || audienceChanged
  if (scrubLiveOverlay) pendingCandleSnapshots.clear()

  await Promise.all([
    replaceRows(persistedTickerCollection, snapshot.tickers, (ticker) => ticker.symbol),
    replaceLiveTickers(snapshot.tickers, true, scrubLiveOverlay),
    replaceRows(watchlistCollection, snapshot.watchlists, (watchlist) => watchlist.id),
    replaceRows(catalystCollection, snapshot.catalysts, (catalyst) => catalyst.id),
    replaceRows(researchCollection, [snapshot.research], (brief) => brief.id),
  ])

  // Each audience publishes exactly one watchlist, so the first row is the default.
  const defaultWatchlist = snapshot.watchlists[0]
  const defaultSymbol = defaultWatchlist?.symbols[0] ?? snapshot.tickers[0]?.symbol ?? 'SPY'
  const currentPreference = preferenceCollection.get('primary')
  if (!currentPreference) {
    const preference = preferenceCollection.insert({
      id: 'primary',
      pinnedSymbols: [],
      selectedSymbol: defaultSymbol,
      selectedWatchlistId: defaultWatchlist?.id ?? 'watchlist',
    })
    await preference.isPersisted.promise
  } else {
    const watchlistIds = new Set(snapshot.watchlists.map((watchlist) => watchlist.id))
    const tickerSymbols = new Set(snapshot.tickers.map((ticker) => ticker.symbol))
    if (!watchlistIds.has(currentPreference.selectedWatchlistId) || !tickerSymbols.has(currentPreference.selectedSymbol)) {
      const preference = preferenceCollection.update('primary', (draft) => {
        draft.selectedSymbol = defaultSymbol
        draft.selectedWatchlistId = defaultWatchlist?.id ?? 'watchlist'
      })
      await preference.isPersisted.promise
    }
  }

  const syncState: SyncState = {
    audience,
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

let snapshotHydrationTail: Promise<void> = Promise.resolve()

export function hydrateCollections(
  snapshot: MarketSnapshot,
  audience: SnapshotAudience = 'owner',
): Promise<void> {
  // Serialize whole-snapshot replacements. An owner request can be aborted after persistence has
  // started; allowing its row writes to overlap a succeeding public replacement could otherwise
  // restore private rows after the public audience marker becomes renderable.
  const hydration = snapshotHydrationTail.then(() => hydrateCollectionsImmediately(snapshot, audience))
  snapshotHydrationTail = hydration.catch(() => undefined)
  return hydration
}

export async function restoreOfflineSnapshot(audience: SnapshotAudience = 'owner') {
  await Promise.all([
    persistedTickerCollection.preload(),
    tickerCollection.preload(),
    watchlistCollection.preload(),
    catalystCollection.preload(),
    researchCollection.preload(),
    syncStateCollection.preload(),
  ])
  const current = syncStateCollection.get('snapshot')
  if (isSnapshotInitialized(current, audience)) {
    const persisted = [...persistedTickerCollection.keys()]
      .flatMap((key) => persistedTickerCollection.get(key) ?? [])
    await replaceLiveTickers(persisted)
  }
}

/** Best-effort protection against browser storage eviction; denial does not block offline use. */
export async function requestPersistentLocalStorage(): Promise<boolean> {
  const hasNavigator = 'navigator' in globalThis
  if (!hasNavigator || !navigator.storage?.persist) return false
  try {
    return await navigator.storage.persist()
  } catch {
    return false
  }
}

export async function syncFromCloud(
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
  audience: SnapshotAudience = 'owner',
): Promise<MarketSnapshot> {
  const response = await fetch(audience === 'owner' ? '/api/snapshot' : '/api/public-snapshot', {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Snapshot sync failed (${response.status})`)
  const snapshot = MarketSnapshotSchema.parse(await response.json())
  if (signal?.aborted || !isCurrent()) throw new DOMException('Snapshot was superseded', 'AbortError')
  await hydrateCollections(snapshot, audience)
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

export async function applyWatchlistMutation(action: WatchlistMutation): Promise<void> {
  const watchlist = [...watchlistCollection.keys()]
    .map((key) => watchlistCollection.get(key))
    .find((candidate) => candidate?.kind === 'private')
  if (!watchlist) return
  const mutation = watchlistCollection.update(watchlist.id, (draft) => {
    const requested = new Set(action.symbols)
    draft.symbols = action.kind === 'add_watchlist_symbols'
      ? [...new Set([...draft.symbols, ...action.symbols])]
      : draft.symbols.filter((symbol) => !requested.has(symbol))
  })
  await mutation.isPersisted.promise
}

type PendingCandleSnapshot = { endSeen: boolean; points: CandlePoint[] }
const pendingCandleSnapshots = new Map<string, PendingCandleSnapshot>()

export function applyLiveMarketEvent(untrusted: JsonValue): void {
  // A closing owner stream may still deliver a queued frame after the public snapshot
  // has replaced it. Never apply that private in-memory overlay outside the owner audience.
  if (syncStateCollection.get('snapshot')?.audience !== 'owner') return
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
