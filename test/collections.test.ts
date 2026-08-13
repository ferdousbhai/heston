import { describe, expect, it } from 'vitest'

import {
  applyLiveMarketEvent,
  hydrateCollections,
  isSnapshotInitialized,
  MAX_LIVE_MARKET_SYMBOLS,
  OFFLINE_SNAPSHOT_VERSION,
  selectLiveMarketSymbols,
  tickerCollection,
  type SyncState,
} from '../src/data/collections'
import { demoSnapshot } from '../src/domain/demo'

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

  it('does not let an older cloud snapshot overwrite newer live market fields', async () => {
    const snapshot = demoSnapshot()
    const original = snapshot.tickers[0]!
    await hydrateCollections({ ...snapshot, tickers: [original] })
    const timestamp = new Date(Date.parse(original.updatedAt) + 60_000).toISOString()
    applyLiveMarketEvent({
      type: 'market', symbol: original.symbol, price: original.price + 10, timestamp,
    })

    await hydrateCollections({ ...snapshot, tickers: [{ ...original, name: 'Updated name' }] })

    expect(tickerCollection.get(original.symbol)).toMatchObject({
      name: 'Updated name',
      price: original.price + 10,
      updatedAt: timestamp,
    })
  })

  it('does not replace a richer live candle series with a newer two-point broker fallback', async () => {
    const snapshot = demoSnapshot()
    const original = snapshot.tickers[0]!
    const baseTime = Date.parse(original.updatedAt)
    const fallback = [
      { time: baseTime - 5 * 60_000, sequence: 0, close: original.price - original.change },
      { time: baseTime, sequence: 0, close: original.price },
    ]
    await hydrateCollections({ ...snapshot, tickers: [{ ...original, sparkline: fallback }] })
    const liveCandles = Array.from({ length: 6 }, (_, index) => ({
      time: baseTime - (5 - index) * 60_000,
      sequence: index + 1,
      close: original.price + index,
    }))
    applyLiveMarketEvent({
      type: 'market', symbol: original.symbol, candleSnapshot: liveCandles, timestamp: original.updatedAt,
    })

    const refreshedAt = new Date(baseTime + 60_000).toISOString()
    await hydrateCollections({
      ...snapshot,
      tickers: [{
        ...original,
        updatedAt: refreshedAt,
        sparkline: [
          { time: baseTime - 4 * 60_000, sequence: 0, close: original.price - original.change },
          { time: baseTime + 60_000, sequence: 0, close: original.price + 1 },
        ],
      }],
    })

    expect(tickerCollection.get(original.symbol)?.sparkline).toEqual(liveCandles)
    expect(tickerCollection.get(original.symbol)?.updatedAt).toBe(refreshedAt)
  })
})
