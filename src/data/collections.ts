import { createCollection, localOnlyCollectionOptions, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

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
  TickerSchema,
  mostActiveSymbol,
  type MarketSnapshot,
  type Ticker,
} from '../domain/market'
import { type WatchlistMutation } from '../domain/watchlist'

// One versioned row now commits the audience and complete server snapshot together.
// Earlier versions spread one snapshot across five independently persisted collections.
export const OFFLINE_SNAPSHOT_VERSION = 7 as const
export const MAX_LIVE_MARKET_SYMBOLS = 100
export type SnapshotAudience = 'owner' | 'public'

const PreferenceSchema = z.object({
  // New anonymous edits get an identity independent of their symbol set. The
  // user-id field remains read-compatible only for preferences written by v2.
  favoriteStageVersion: z.string().uuid().optional(),
  favoriteUserId: z.string().min(1).max(256).optional(),
  id: z.literal('primary'),
  pinnedSymbols: z.array(EquitySymbolSchema).max(MAX_LIVE_MARKET_SYMBOLS).default([]),
  selectedByUser: z.boolean().optional(),
  selectedSymbol: z.string(),
  selectedWatchlistId: z.string(),
})

export type Preference = z.infer<typeof PreferenceSchema>

const LEGACY_SNAPSHOT_STORAGE_PREFIXES = [
  'spice.catalysts.v',
  'spice.research.v',
  'spice.sync-state.v',
  'spice.tickers.v',
  'spice.watchlists.v',
]

const OfflineSnapshotSchema = z.object({
  audience: z.enum(['owner', 'public']),
  id: z.literal('snapshot'),
  schemaVersion: z.literal(OFFLINE_SNAPSHOT_VERSION),
  snapshot: MarketSnapshotSchema,
})

export const offlineSnapshotCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-offline-snapshot',
    storageKey: `spice.snapshot.v${OFFLINE_SNAPSHOT_VERSION}`,
    schema: OfflineSnapshotSchema,
    getKey: (record) => record.id,
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

export const preferenceCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-preferences',
    storageKey: 'spice.preferences.v2',
    schema: PreferenceSchema,
    getKey: (preference) => preference.id,
    startSync: true,
  }),
)

type PersistedMutation = { isPersisted: { promise: Promise<unknown> } }

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

async function replaceLiveTickers(
  rows: readonly Ticker[],
  replaceExisting = false,
): Promise<void> {
  const mutations: PersistedMutation[] = []
  const incoming = new Set(rows.map((ticker) => ticker.symbol))
  // TanStack applies deletes optimistically, so snapshot the iterator before mutating it.
  const deletedKeys = Array.from(tickerCollection.keys()).filter((key) => !incoming.has(key))
  if (deletedKeys.length) mutations.push(tickerCollection.delete(deletedKeys))
  const insertedRows: Ticker[] = []
  const updatedRows: Ticker[] = []
  for (const row of rows) {
    if (tickerCollection.get(row.symbol)) updatedRows.push(row)
    else insertedRows.push(row)
  }
  if (updatedRows.length) {
    mutations.push(tickerCollection.update(updatedRows.map((ticker) => ticker.symbol), (drafts) => {
      drafts.forEach((draft, index) => {
        const ticker = updatedRows[index]!
        if (replaceExisting) {
          Object.assign(draft, ticker)
          return
        }
        const sparkline = reconcileCandleSeries(draft.sparkline, ticker.sparkline)
        if (Date.parse(draft.updatedAt) > Date.parse(ticker.updatedAt)) {
          const { change, changePercent, price, updatedAt } = draft
          Object.assign(draft, ticker, { change, changePercent, price, sparkline, updatedAt })
          return
        }
        Object.assign(draft, ticker, { sparkline })
      })
    }))
  }
  if (insertedRows.length) mutations.push(tickerCollection.insert(insertedRows))
  await Promise.all(mutations.map((mutation) => mutation.isPersisted.promise))
}

async function preloadSnapshotCollections(): Promise<void> {
  await Promise.all([
    offlineSnapshotCollection.preload(),
    tickerCollection.preload(),
    preferenceCollection.preload(),
  ])
  const storage = globalThis.window?.localStorage
  if (storage) {
    // Retire every split-snapshot generation after the atomic collection is ready.
    // This removes stale owner rows without touching preferences or favorite staging.
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key && LEGACY_SNAPSHOT_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        storage.removeItem(key)
      }
    }
  }
}

async function persistOfflineSnapshot(snapshot: MarketSnapshot, audience: SnapshotAudience): Promise<void> {
  const record = { audience, id: 'snapshot' as const, schemaVersion: OFFLINE_SNAPSHOT_VERSION, snapshot }
  const mutation = offlineSnapshotCollection.get('snapshot')
    ? offlineSnapshotCollection.update('snapshot', (draft) => Object.assign(draft, record))
    : offlineSnapshotCollection.insert(record)
  await mutation.isPersisted.promise
}

async function updateSnapshotPreference(snapshot: MarketSnapshot): Promise<void> {
  // Each audience publishes exactly one watchlist, so the first row is the default.
  const defaultWatchlist = snapshot.watchlists[0]!
  const defaultSymbol = mostActiveSymbol(snapshot.tickers, defaultWatchlist.symbols)
  const currentPreference = preferenceCollection.get('primary')
  if (!currentPreference && defaultSymbol) {
    const preference = preferenceCollection.insert({
      id: 'primary',
      pinnedSymbols: [],
      selectedByUser: false,
      selectedSymbol: defaultSymbol,
      selectedWatchlistId: defaultWatchlist.id,
    })
    await preference.isPersisted.promise
    return
  }
  if (!currentPreference || !defaultSymbol) return

  const watchlistIds = new Set(snapshot.watchlists.map((watchlist) => watchlist.id))
  const tickerSymbols = new Set(snapshot.tickers.map((ticker) => ticker.symbol))
  const selectionInvalid = !watchlistIds.has(currentPreference.selectedWatchlistId)
    || !tickerSymbols.has(currentPreference.selectedSymbol)
  if (selectionInvalid || (!currentPreference.selectedByUser && currentPreference.selectedSymbol !== defaultSymbol)) {
    const preference = preferenceCollection.update('primary', (draft) => {
      draft.selectedByUser = false
      draft.selectedSymbol = defaultSymbol
      draft.selectedWatchlistId = defaultWatchlist.id
    })
    await preference.isPersisted.promise
  }
}

async function hydrateCollectionsImmediately(snapshot: MarketSnapshot, audience: SnapshotAudience): Promise<void> {
  await preloadSnapshotCollections()
  const previous = offlineSnapshotCollection.get('snapshot')
  const audienceChanged = Boolean(previous && previous.audience !== audience)
  if (audienceChanged) {
    // Hide the old audience before owner-only live fields can enter an opposite
    // audience's overlay. The next persisted row is still one complete snapshot.
    await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
  }
  const replaceExisting = audience === 'public' || audienceChanged
  if (replaceExisting) pendingCandleSnapshots.clear()
  await replaceLiveTickers(snapshot.tickers, replaceExisting)
  await persistOfflineSnapshot(snapshot, audience)
  await updateSnapshotPreference(snapshot)
}

let snapshotOperationTail: Promise<void> = Promise.resolve()

function queueSnapshotOperation(operation: () => Promise<void>): Promise<void> {
  const result = snapshotOperationTail.then(operation)
  // The caller still receives this operation's rejection; only the private queue tail
  // recovers so a later audience change is not permanently blocked by an earlier failure.
  snapshotOperationTail = result.catch(() => undefined)
  return result
}

export function hydrateCollections(
  snapshot: MarketSnapshot,
  audience: SnapshotAudience = 'owner',
): Promise<void> {
  // Serialize record and live-overlay replacements so an aborted owner request cannot
  // race a succeeding public replacement and restore private quote fields afterward.
  return queueSnapshotOperation(() => hydrateCollectionsImmediately(snapshot, audience))
}

async function restoreOfflineSnapshotImmediately(audience: SnapshotAudience): Promise<void> {
  await preloadSnapshotCollections()
  const record = offlineSnapshotCollection.get('snapshot')
  if (record?.audience === audience) {
    const replaceExisting = audience === 'public'
    if (replaceExisting) pendingCandleSnapshots.clear()
    await replaceLiveTickers(record.snapshot.tickers, replaceExisting)
    await updateSnapshotPreference(record.snapshot)
    return
  }

  // A record for another audience is unusable even when no component has observed it.
  if (record) await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
  pendingCandleSnapshots.clear()
  await replaceLiveTickers([], true)
}

export function restoreOfflineSnapshot(audience: SnapshotAudience = 'owner'): Promise<void> {
  return queueSnapshotOperation(() => restoreOfflineSnapshotImmediately(audience))
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
  // The root document preloads the public snapshot as a fetch. Any extra request header
  // here would miss that preload and refetch it, so the public read sends none.
  const response = audience === 'owner'
    ? await fetch('/api/snapshot', { headers: { Accept: 'application/json' }, signal })
    : await fetch('/api/public-snapshot', { signal })
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
    draft.selectedByUser = true
    draft.selectedSymbol = symbol
  })
}

export async function applyWatchlistMutation(action: WatchlistMutation): Promise<void> {
  const record = offlineSnapshotCollection.get('snapshot')
  const watchlist = record?.audience === 'owner'
    ? record.snapshot.watchlists.find((candidate) => candidate.kind === 'private')
    : undefined
  if (!watchlist) throw new Error('Owner watchlist snapshot is unavailable')
  const mutation = offlineSnapshotCollection.update('snapshot', (draft) => {
    const privateWatchlist = draft.snapshot.watchlists.find((candidate) => candidate.kind === 'private')
    if (!privateWatchlist) throw new Error('Owner watchlist snapshot is unavailable')
    const requested = new Set(action.symbols)
    privateWatchlist.symbols = action.kind === 'add_watchlist_symbols'
      ? [...new Set([...privateWatchlist.symbols, ...action.symbols])]
      : privateWatchlist.symbols.filter((symbol) => !requested.has(symbol))
  })
  await mutation.isPersisted.promise
}

type PendingCandleSnapshot = { endSeen: boolean; points: CandlePoint[] }
const pendingCandleSnapshots = new Map<string, PendingCandleSnapshot>()

export function applyLiveMarketEvent(untrusted: JsonValue): void {
  // A closing owner stream may still deliver a queued frame after the public snapshot
  // has replaced it. Never apply that private in-memory overlay outside the owner audience.
  if (offlineSnapshotCollection.get('snapshot')?.audience !== 'owner') return
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
