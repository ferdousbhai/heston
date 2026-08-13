import { describe, expect, it } from 'vitest'

import {
  applyLiveMarketEvent,
  hydrateCollections,
  isSnapshotInitialized,
  legacySnapshotFromStorage,
  MAX_LIVE_MARKET_SYMBOLS,
  OFFLINE_SNAPSHOT_VERSION,
  selectLiveMarketSymbols,
  tickerCollection,
  type SyncState,
} from '../src/data/collections'
import { demoSnapshot } from '../src/domain/demo'

function stored(rows: readonly unknown[], keys: readonly string[]): string {
  return JSON.stringify(Object.fromEntries(rows.map((row, index) => [
    `s:${keys[index]}`,
    { data: row, versionKey: `version-${index}` },
  ])))
}

function legacyStorage(source: 'demo' | 'tastytrade' = 'tastytrade') {
  const snapshot = demoSnapshot()
  const values = new Map<string, string>([
    ['spice.sync-state.v1', stored([{
      id: 'snapshot', marketState: snapshot.marketState, source, syncedAt: snapshot.syncedAt,
    }], ['snapshot'])],
    ['spice.tickers.v1', stored(snapshot.tickers.map((ticker) => ({
      ...ticker,
      sparkline: ticker.sparkline.map((point) => point.close),
    })), snapshot.tickers.map((ticker) => ticker.symbol))],
    ['spice.watchlists.v1', stored(snapshot.watchlists, snapshot.watchlists.map((watchlist) => watchlist.id))],
    ['spice.catalysts.v1', stored([], [])],
    ['spice.research.v1', stored([snapshot.research], [snapshot.research.id])],
  ])
  return { getItem: (key: string) => values.get(key) ?? null }
}

describe('offline snapshot boundary', () => {
  it('treats a version marker, not collection row counts, as initialization', () => {
    const liveState: SyncState = {
      id: 'snapshot',
      marketState: 'closed',
      schemaVersion: OFFLINE_SNAPSHOT_VERSION,
      source: 'tastytrade',
      syncedAt: '2026-08-13T20:00:00.000Z',
    }

    expect(isSnapshotInitialized(liveState, false)).toBe(true)
    expect(isSnapshotInitialized({ ...liveState, source: 'demo' }, false)).toBe(false)
    expect(isSnapshotInitialized({ ...liveState, source: 'demo' }, true)).toBe(true)
    expect(isSnapshotInitialized(undefined, true)).toBe(false)
  })

  it('migrates a coherent live v1 snapshot, including a valid empty catalyst collection', () => {
    const migrated = legacySnapshotFromStorage(legacyStorage(), false)

    expect(migrated?.source).toBe('tastytrade')
    expect(migrated?.catalysts).toEqual([])
    expect(migrated?.tickers[0]?.sparkline[0]).toEqual(expect.objectContaining({
      sequence: 0,
      close: expect.any(Number),
      time: expect.any(Number),
    }))
  })

  it('never migrates demo data into a live runtime', () => {
    expect(legacySnapshotFromStorage(legacyStorage('demo'), false)).toBeUndefined()
    expect(legacySnapshotFromStorage(legacyStorage('demo'), true)?.source).toBe('demo')
  })

  it('does not mark an incomplete legacy snapshot as initialized', () => {
    const storage = legacyStorage()
    expect(legacySnapshotFromStorage({
      getItem: (key) => key === 'spice.research.v1' ? null : storage.getItem(key),
    }, false)).toBeUndefined()
  })
})

describe('live market subscriptions', () => {
  it('keeps the selected loaded symbol first, drops unloaded symbols, deduplicates, and bounds the relay', () => {
    const loaded = Array.from({ length: MAX_LIVE_MARKET_SYMBOLS + 20 }, (_, index) => `S${index}`)
    const symbols = selectLiveMarketSymbols('S110', ['S1', 'MISSING', 'S110', ...loaded], loaded)

    expect(symbols).toHaveLength(MAX_LIVE_MARKET_SYMBOLS)
    expect(symbols.slice(0, 3)).toEqual(['S110', 'S1', 'S0'])
    expect(symbols).not.toContain('MISSING')
  })

  it('keeps the newest quote and recomputes the daily move from the prior close', async () => {
    const snapshot = demoSnapshot()
    const original = snapshot.tickers[0]!
    await hydrateCollections({ ...snapshot, tickers: [original] })
    const priorClose = original.price - original.change
    const timestamp = new Date(Date.parse(original.updatedAt) + 60_000).toISOString()

    applyLiveMarketEvent({
      type: 'market', symbol: original.symbol, price: original.price + 10, timestamp,
    })
    expect(tickerCollection.get(original.symbol)).toMatchObject({
      change: original.price + 10 - priorClose,
      updatedAt: timestamp,
    })

    applyLiveMarketEvent({
      type: 'market', symbol: original.symbol, price: 1, timestamp: original.updatedAt,
    })
    expect(tickerCollection.get(original.symbol)?.price).toBe(original.price + 10)
  })
})
