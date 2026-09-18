import { createCollection, localOnlyCollectionOptions, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { type JsonValue } from '../domain/json-payload'
import {
  CandleSnapshotAccumulator,
  DXLINK_REMOVE_EVENT,
  reconcileCandleSeries,
  updateCandleSeries,
} from '../domain/candle'
import {
  LiveMarketEventSchema,
  type LiveMarketEvent,
} from '../server/market-feed-contracts'
import {
  MarketSnapshotSchema,
  marketSnapshotFromPublic,
  PublicMarketSnapshotSchema,
  TickerSchema,
  PublicSymbolLookupSchema,
  tickerFromPublic,
  type PublicSymbolLookup,
  mostActiveSymbol,
  type MarketSnapshot,
  type Ticker,
} from '../domain/market'
import { MAX_FAVORITE_SYMBOLS } from '../domain/favorites'
import { MAX_LIVE_STREAM_SYMBOLS } from '../domain/watchlist'
import { OWNER_SNAPSHOT_URL, PUBLIC_SNAPSHOT_URL } from '../deployment'
import { browserStorage, type EnumerableStorage } from './browser-storage'
import { clearDeploymentReload, DeploymentMismatchError, newerResponseDeployment } from './deployment'

// One versioned row now commits the audience and complete server snapshot together.
// Earlier versions spread one snapshot across five independently persisted collections.
export const OFFLINE_SNAPSHOT_VERSION = 9 as const
export type SnapshotAudience = 'owner' | 'public'

const OFFLINE_SNAPSHOT_STORAGE_PREFIX = 'spice.snapshot.v'
export const OFFLINE_SNAPSHOT_STORAGE_KEY = `${OFFLINE_SNAPSHOT_STORAGE_PREFIX}${OFFLINE_SNAPSHOT_VERSION}`

type SnapshotStorage = Pick<EnumerableStorage, 'key' | 'length' | 'removeItem'>

const LEGACY_SNAPSHOT_STORAGE_PREFIXES = [
  'spice.catalysts.v',
  'spice.research.v',
  'spice.recommendations.v',
  'spice.sync-state.v',
  'spice.tickers.v',
  'spice.watchlists.v',
]

export function retireLegacySnapshotStorage(storage: SnapshotStorage): void {
  // Deployments keep the same offline row when its schema remains compatible. Only an
  // explicit schema bump retires it; split generations are always obsolete now that the
  // snapshot commits atomically. Preferences and favorite staging are user-authored.
  for (let index = storage.length - 1; index >= 0; index -= 1) {
    const key = storage.key(index)
    if (key === null) continue
    const obsoleteAtomicSnapshot = key.startsWith(OFFLINE_SNAPSHOT_STORAGE_PREFIX)
      && key !== OFFLINE_SNAPSHOT_STORAGE_KEY
    const obsoleteSplitSnapshot = LEGACY_SNAPSHOT_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix))
    if (obsoleteAtomicSnapshot || obsoleteSplitSnapshot) {
      storage.removeItem(key)
    }
  }
}

const PreferenceSchema = z.object({
  // New anonymous edits get an identity independent of their symbol set. The
  // user-id field remains read-compatible only for preferences written by v2.
  favoriteStageVersion: z.string().uuid().optional(),
  favoriteUserId: z.string().min(1).max(256).optional(),
  id: z.literal('primary'),
  pinnedSymbols: z.array(EquitySymbolSchema).max(MAX_FAVORITE_SYMBOLS),
  selectedByUser: z.boolean().optional(),
  selectedSymbol: z.string(),
  selectedWatchlistId: z.string(),
})

export type Preference = z.infer<typeof PreferenceSchema>

const OfflineSnapshotSchema = z.object({
  audience: z.enum(['owner', 'public']),
  id: z.literal('snapshot'),
  schemaVersion: z.literal(OFFLINE_SNAPSHOT_VERSION),
  snapshot: MarketSnapshotSchema,
})

export const offlineSnapshotCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-offline-snapshot',
    storageKey: OFFLINE_SNAPSHOT_STORAGE_KEY,
    storage: browserStorage,
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
    storage: browserStorage,
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
  // The watchlist may hold more names than one browser should subscribe to. The
  // selected symbol leads, so the row the reader is actually reading always streams.
  return [...new Set([...(selectedSymbol ? [selectedSymbol] : []), ...watchlistSymbols])]
    .filter((symbol) => loaded.has(symbol))
    .slice(0, MAX_LIVE_STREAM_SYMBOLS)
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
  // A symbol that leaves the overlay takes its half-delivered snapshot with it; otherwise the
  // buffered points outlive the row they were being assembled for.
  for (const key of deletedKeys) candleSnapshots.forget(key)
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
  retireLegacySnapshotStorage(browserStorage)
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
  // A watchlist whose identity changed says nothing about the symbol the reader picked, and
  // the two audiences publish different watchlist ids — so treating one unknown id as proof
  // that the whole selection was stale threw away the reader's choice on every sign-in and
  // sent them back to whatever happened to be busiest that morning.
  const keepsChoice = Boolean(currentPreference.selectedByUser)
    && tickerSymbols.has(currentPreference.selectedSymbol)
  const selectedSymbol = keepsChoice ? currentPreference.selectedSymbol : defaultSymbol
  const selectedWatchlistId = watchlistIds.has(currentPreference.selectedWatchlistId)
    ? currentPreference.selectedWatchlistId
    : defaultWatchlist.id
  if (selectedSymbol !== currentPreference.selectedSymbol
    || selectedWatchlistId !== currentPreference.selectedWatchlistId
    || keepsChoice !== Boolean(currentPreference.selectedByUser)) {
    const preference = preferenceCollection.update('primary', (draft) => {
      draft.selectedByUser = keepsChoice
      draft.selectedSymbol = selectedSymbol
      draft.selectedWatchlistId = selectedWatchlistId
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
  if (replaceExisting) candleSnapshots.clear()
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
    if (replaceExisting) candleSnapshots.clear()
    await replaceLiveTickers(record.snapshot.tickers, replaceExisting)
    await updateSnapshotPreference(record.snapshot)
    return
  }

  // A record for another audience is unusable even when no component has observed it.
  if (record) await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
  candleSnapshots.clear()
  await replaceLiveTickers([], true)
}

async function previewPublicSnapshotImmediately(): Promise<void> {
  await preloadSnapshotCollections()
  const record = offlineSnapshotCollection.get('snapshot')
  // Only a public record may be drawn before the session check names the viewer. An owner
  // record is the one thing that must wait: on a shared device the person looking may have
  // signed out, and the audience tag exists so they never see what the last session held.
  if (record?.audience !== 'public') return
  candleSnapshots.clear()
  await replaceLiveTickers(record.snapshot.tickers, true)
}

/**
 * Draw what a visitor may already have while the session check runs, so an anonymous reader
 * is not made to wait on a question that has no bearing on what they can see.
 */
export function previewPublicSnapshot(): Promise<void> {
  return queueSnapshotOperation(previewPublicSnapshotImmediately)
}

export function restoreOfflineSnapshot(audience: SnapshotAudience = 'owner'): Promise<void> {
  return queueSnapshotOperation(() => restoreOfflineSnapshotImmediately(audience))
}

let publicSnapshotEtag: string | undefined

export async function syncFromCloud(
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
  audience: SnapshotAudience = 'owner',
): Promise<MarketSnapshot> {
  // The root document preloads the public snapshot as a fetch. Any extra request header
  // here would miss that preload and refetch it, so the first public read sends none.
  // Later syncs send If-None-Match so an unchanged observation is a 304, not another body.
  const headers = new Headers()
  if (audience === 'owner') headers.set('Accept', 'application/json')
  if (audience === 'public' && publicSnapshotEtag) headers.set('If-None-Match', publicSnapshotEtag)
  const response = audience === 'owner'
    ? await fetch(OWNER_SNAPSHOT_URL, { headers, signal })
    : await fetch(PUBLIC_SNAPSHOT_URL, { headers, signal })
  if (response.status === 304) {
    const record = offlineSnapshotCollection.get('snapshot')
    if (record?.audience === audience) return record.snapshot
    throw new Error('Snapshot sync failed (304)')
  }
  // A failed request is a failed request; reading a deployment header off one only disguised
  // the status that actually explains it.
  if (!response.ok) throw new Error(`Snapshot sync failed (${response.status})`)
  const etag = response.headers.get('ETag')
  if (audience === 'public' && etag) publicSnapshotEtag = etag
  const payload: unknown = await response.json()
  const newerDeployment = newerResponseDeployment(response)
  let snapshot: MarketSnapshot
  try {
    snapshot = audience === 'owner'
      ? MarketSnapshotSchema.parse(payload)
      : marketSnapshotFromPublic(PublicMarketSnapshotSchema.parse(payload))
  } catch (cause) {
    // A payload this bundle cannot read is the only real incompatibility, and a newer
    // deployment is the reason worth naming for it.
    if (newerDeployment) throw new DeploymentMismatchError(newerDeployment)
    throw cause
  }
  if (signal?.aborted || !isCurrent()) throw new DOMException('Snapshot was superseded', 'AbortError')
  // Readable data is worth showing even when a newer build exists: the reader gets the market
  // while the page refreshes itself underneath them, instead of an empty screen and a notice.
  await hydrateCollections(snapshot, audience)
  if (newerDeployment) throw new DeploymentMismatchError(newerDeployment, true)
  clearDeploymentReload()
  return snapshot
}

async function retainSymbolLookupImmediately(lookup: PublicSymbolLookup): Promise<void> {
  const symbol = lookup.ticker.symbol
  const record = offlineSnapshotCollection.get('snapshot')
  if (!record) throw new Error('Market snapshot is unavailable')
  if (!tickerCollection.has(symbol)) {
    // A catalog response is public data. Serialize its admission with audience changes,
    // and persist it before selecting so reopening the app can resolve the same choice.
    const snapshot = record.snapshot
    await hydrateCollectionsImmediately({
      ...snapshot,
      tickers: [...snapshot.tickers, tickerFromPublic(lookup.ticker)],
      catalysts: [...snapshot.catalysts.filter((row) => !lookup.catalysts.some((next) => next.id === row.id)), ...lookup.catalysts],
      watchlists: snapshot.watchlists.map((list) => ({ ...list, symbols: [...new Set([...list.symbols, symbol])].sort() })),
    }, record.audience)
  }
}

export function retainSymbolLookup(lookup: PublicSymbolLookup): Promise<void> {
  const parsed = PublicSymbolLookupSchema.parse(lookup)
  return queueSnapshotOperation(() => retainSymbolLookupImmediately(parsed))
}

export function selectTicker(symbol: string, lookup?: PublicSymbolLookup): Promise<void> {
  return queueSnapshotOperation(async () => {
    if (lookup) {
      const parsed = PublicSymbolLookupSchema.parse(lookup)
      if (parsed.ticker.symbol !== symbol) throw new Error('Market selection does not match the search result')
      await retainSymbolLookupImmediately(parsed)
    }
    if (!tickerCollection.has(symbol)) throw new Error('Selected market symbol is unavailable')
    const current = preferenceCollection.get('primary')
    if (!current) throw new Error('Market preference is unavailable')
    const mutation = preferenceCollection.update('primary', (draft) => {
      draft.selectedByUser = true
      draft.selectedSymbol = symbol
    })
    await mutation.isPersisted.promise
  })
}

const candleSnapshots = new CandleSnapshotAccumulator()

export function applyLiveMarketEvent(untrusted: JsonValue): void {
  // A closing owner stream may still deliver a queued frame after the public snapshot
  // has replaced it. Never apply that private in-memory overlay outside the owner audience.
  if (offlineSnapshotCollection.get('snapshot')?.audience !== 'owner') return
  const event: LiveMarketEvent = LiveMarketEventSchema.parse(untrusted)
  if (!tickerCollection.get(event.symbol)) throw new Error(`LiveMarketEvent:unknown-symbol:${event.symbol}`)
  tickerCollection.update(event.symbol, (ticker) => {
    const eventAt = Date.parse(event.timestamp)
    const tickerAt = Date.parse(ticker.updatedAt)
    const hasMarketPrice = event.price !== undefined || event.change !== undefined
    if (hasMarketPrice && eventAt >= tickerAt) {
      const priorClose = ticker.price - ticker.change
      if (event.price !== undefined) ticker.price = event.price
      if (event.change !== undefined) ticker.change = event.change
      else if (event.price !== undefined && priorClose > 0) ticker.change = event.price - priorClose
      // Only a frame that carried a price alongside the change implies a new close; a
      // change-only frame leaves `ticker.price` stale, so the stored pair's close still rules.
      const referenceClose = event.price !== undefined && event.change !== undefined
        ? ticker.price - ticker.change
        : priorClose
      if (referenceClose > 0) ticker.changePercent = (ticker.change / referenceClose) * 100
      ticker.updatedAt = event.timestamp
    }
    if (event.candleSnapshot?.length) {
      candleSnapshots.forget(event.symbol)
      ticker.sparkline = event.candleSnapshot
    }
    if (event.candle) {
      const { eventFlags, ...point } = event.candle
      const result = candleSnapshots.accept(event.symbol, event.candle)
      if (result.status === 'live') {
        ticker.sparkline = updateCandleSeries(
          ticker.sparkline,
          point,
          Boolean(eventFlags & DXLINK_REMOVE_EVENT),
        )
      } else if (result.status === 'complete' && result.points.length) {
        ticker.sparkline = result.points
      }
    }
  })
}
