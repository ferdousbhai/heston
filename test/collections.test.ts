import { describe, expect, it } from 'vitest'

import {
  applyLiveMarketEvent,
  hydrateCollections,
  offlineSnapshotCollection,
  OFFLINE_SNAPSHOT_VERSION,
  restoreOfflineSnapshot,
  selectLiveMarketSymbols,
  tickerCollection,
} from '../src/data/collections'
import { mostActiveSymbol } from '../src/domain/market'
import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { marketSnapshotFixture } from './fixtures/market'

describe('default market focus', () => {
  it('chooses the highest-volume loaded ticker in the active watchlist', () => {
    const tickers = marketSnapshotFixture().tickers

    expect(mostActiveSymbol(tickers, ['META', 'NVDA', 'INTC'])).toBe('NVDA')
    expect(mostActiveSymbol(tickers, ['META', 'INTC'])).toBe('INTC')
    expect(mostActiveSymbol(tickers, ['MISSING'])).toBe('NVDA')
    expect(mostActiveSymbol([], ['NVDA'])).toBeUndefined()
  })
})

describe('offline snapshot boundary', () => {
  it('persists the audience and full server snapshot as one versioned record', async () => {
    const snapshot = marketSnapshotFixture()

    await hydrateCollections(snapshot, 'owner')

    expect([...offlineSnapshotCollection.keys()]).toEqual(['snapshot'])
    expect(offlineSnapshotCollection.get('snapshot')).toMatchObject({
      audience: 'owner',
      id: 'snapshot',
      schemaVersion: OFFLINE_SNAPSHOT_VERSION,
      snapshot,
    })
  })

  it('restores only the exact persisted audience and clears an opposite in-memory projection', async () => {
    const snapshot = marketSnapshotFixture()
    await hydrateCollections(snapshot, 'owner')
    await tickerCollection.delete([...tickerCollection.keys()]).isPersisted.promise

    await restoreOfflineSnapshot('owner')

    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('owner')
    expect([...tickerCollection.keys()].sort()).toEqual(snapshot.tickers.map((ticker) => ticker.symbol).sort())

    await restoreOfflineSnapshot('public')

    expect(offlineSnapshotCollection.get('snapshot')).toBeUndefined()
    expect([...tickerCollection.keys()]).toEqual([])
  })

  it('replaces owner cache and live overlay with only public rows before marking it public', async () => {
    const owner = marketSnapshotFixture()
    const original = owner.tickers.find((ticker) => ticker.position)!
    await hydrateCollections({ ...owner, tickers: [original] }, 'owner')
    const liveAt = new Date(Date.parse(original.updatedAt) + 60_000).toISOString()
    applyLiveMarketEvent({
      candleSnapshot: [
        ...original.sparkline,
        { close: original.price + 10, sequence: 1, time: Date.parse(liveAt) },
      ],
      price: original.price + 10,
      symbol: original.symbol,
      timestamp: liveAt,
      type: 'market',
    })
    // Simulate atomic storage eviction while owner-only quote data remains in memory.
    await offlineSnapshotCollection.delete('snapshot').isPersisted.promise
    const publicTicker = {
      ...original,
      change: 1,
      changePercent: 0.5,
      position: false,
      price: original.price - 5,
      sparkline: original.sparkline.slice(-2),
    }
    const publicSnapshot = {
      ...owner,
      tickers: [publicTicker],
      watchlists: [{ id: 'public-options-watch', kind: 'public' as const, name: 'Options Watch', symbols: ['NVDA'] }],
    }

    await hydrateCollections(publicSnapshot, 'public')

    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('public')
    expect(offlineSnapshotCollection.get('snapshot')?.snapshot.watchlists.map((watchlist) => watchlist.id))
      .toEqual(['public-options-watch'])
    expect(tickerCollection.get(original.symbol)).toMatchObject(publicTicker)

    applyLiveMarketEvent({
      price: original.price + 20,
      symbol: original.symbol,
      timestamp: new Date(Date.parse(liveAt) + 60_000).toISOString(),
      type: 'market',
    })
    expect(tickerCollection.get(original.symbol)).toMatchObject(publicTicker)
  })

  it('serializes overlapping audience replacements so the last requested snapshot wins', async () => {
    const owner = marketSnapshotFixture()
    const privateTicker = owner.tickers.find((ticker) => ticker.position)!
    const publicTicker = {
      ...owner.tickers.find((ticker) => !ticker.position)!,
      position: false,
    }
    const publicSnapshot = {
      ...owner,
      tickers: [publicTicker],
      watchlists: [{
        id: 'public-options-watch',
        kind: 'public' as const,
        name: 'Options Watch',
        symbols: [publicTicker.symbol],
      }],
    }

    const ownerHydration = hydrateCollections({
      ...owner,
      tickers: [privateTicker],
      watchlists: [{
        id: 'private-watchlist',
        kind: 'private' as const,
        name: 'Private',
        symbols: [privateTicker.symbol],
      }],
    }, 'owner')
    const publicHydration = hydrateCollections(publicSnapshot, 'public')

    await Promise.all([ownerHydration, publicHydration])

    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('public')
    expect(offlineSnapshotCollection.get('snapshot')?.snapshot.watchlists.map((watchlist) => watchlist.id))
      .toEqual(['public-options-watch'])
    expect([...tickerCollection.keys()]).toEqual([publicTicker.symbol])
    expect(tickerCollection.get(privateTicker.symbol)).toBeUndefined()
  })

})

describe('live market subscriptions', () => {
  it('keeps the selected loaded symbol first, drops unloaded symbols, and deduplicates', () => {
    const loaded = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => `S${index}`)
    const symbols = selectLiveMarketSymbols('S10', ['S1', 'MISSING', 'S10', ...loaded], loaded)

    expect(symbols).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(symbols.slice(0, 3)).toEqual(['S10', 'S1', 'S0'])
    expect(symbols).not.toContain('MISSING')
  })

  it('rejects a live subscription overflow instead of dropping symbols', () => {
    const loaded = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 1 }, (_, index) => `S${index}`)
    expect(() => selectLiveMarketSymbols(undefined, loaded, loaded)).toThrow('too-many-symbols')
  })

  it('keeps the newest quote and recomputes the daily move from the prior close', async () => {
    const snapshot = marketSnapshotFixture()
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
    const snapshot = marketSnapshotFixture()
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

  it('does not replace a richer live candle series with a shorter broker candle series', async () => {
    const snapshot = marketSnapshotFixture()
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
