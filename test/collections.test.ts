import { describe, expect, it } from 'vitest'

import {
  applyLiveMarketEvent,
  selectTicker,
  hydrateCollections,
  offlineSnapshotCollection,
  preferenceCollection,
  previewPublicSnapshot,
  OFFLINE_SNAPSHOT_STORAGE_KEY,
  OFFLINE_SNAPSHOT_VERSION,
  restoreOfflineSnapshot,
  retireLegacySnapshotStorage,
  selectLiveMarketSymbols,
  tickerCollection,
} from '../src/data/collections'
import { audienceMarketView } from '../src/data/use-audience-market'
import { mostActiveSymbol } from '../src/domain/market'
import { MAX_LIVE_STREAM_SYMBOLS, MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
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
  it('retires legacy snapshot storage without deleting user-authored browser state', () => {
    const rows = new Map([
      ['spice.snapshot.v8', 'old schema'],
      ['spice.snapshot.v9.previous-build', 'old deployment'],
      ['spice.tickers.v6', 'old split snapshot'],
      [OFFLINE_SNAPSHOT_STORAGE_KEY, 'current schema'],
      ['spice.preferences.v2', 'preferences'],
      ['spice.favorite-stage.v1', 'favorite staging'],
    ])
    const storage = {
      get length() { return rows.size },
      key: (index: number) => [...rows.keys()][index] ?? null,
      removeItem: (key: string) => { rows.delete(key) },
    }

    retireLegacySnapshotStorage(storage)

    expect([...rows.keys()]).toEqual([
      OFFLINE_SNAPSHOT_STORAGE_KEY,
      'spice.preferences.v2',
      'spice.favorite-stage.v1',
    ])
  })

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
    const original = owner.tickers[0]!
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
    const privateTicker = owner.tickers[0]!
    const publicTicker = {
      ...owner.tickers[1]!,
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
    const loaded = Array.from({ length: MAX_LIVE_STREAM_SYMBOLS }, (_, index) => `S${index}`)
    const symbols = selectLiveMarketSymbols('S10', ['S1', 'MISSING', 'S10', ...loaded], loaded)

    expect(symbols).toHaveLength(MAX_LIVE_STREAM_SYMBOLS)
    expect(symbols.slice(0, 3)).toEqual(['S10', 'S1', 'S0'])
    expect(symbols).not.toContain('MISSING')
  })

  it('subscribes to the selected symbol first when the watchlist outgrows the stream limit', () => {
    const loaded = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => `S${index}`)
    const symbols = selectLiveMarketSymbols('S499', loaded, loaded)

    expect(symbols).toHaveLength(MAX_LIVE_STREAM_SYMBOLS)
    expect(symbols[0]).toBe('S499')
    expect(symbols).toContain('S0')
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

  it('draws a visitor\'s cache during the session check but never an owner\'s', async () => {
    const snapshot = marketSnapshotFixture()
    await hydrateCollections(snapshot, 'public')
    await previewPublicSnapshot()
    expect(tickerCollection.size).toBeGreaterThan(0)

    // An owner record must wait for the check: on a shared device the person looking may have
    // signed out, and the audience tag is what keeps the last session out of their view. The
    // preview leaves the record for the real restore rather than consuming or clearing it.
    await hydrateCollections(snapshot, 'owner')
    await previewPublicSnapshot()
    const stored = offlineSnapshotCollection.get('snapshot')
    expect(stored?.audience).toBe('owner')
    // Nothing owner-tagged is renderable to a viewer the check has not claimed yet.
    expect(audienceMarketView('public', stored ? [stored] : [], [...tickerCollection.values()]).snapshot)
      .toBeUndefined()
  })

  it('keeps a stored snapshot that a later session check will claim', async () => {
    const snapshot = marketSnapshotFixture()
    await hydrateCollections(snapshot, 'owner')

    // Restoring the audience the record actually belongs to returns the reader to the market
    // they left, rather than to an empty screen that has to fetch it again.
    await restoreOfflineSnapshot('owner')
    expect(offlineSnapshotCollection.get('snapshot')?.audience).toBe('owner')
    expect(tickerCollection.size).toBeGreaterThan(0)
  })

  it('keeps the reader\'s chosen symbol when the audience changes the watchlist', async () => {
    const snapshot = marketSnapshotFixture()
    await hydrateCollections(snapshot, 'owner')
    // A deliberate pick, on a symbol that is not the busiest.
    const chosen = snapshot.tickers.find((ticker) => ticker.symbol === 'INTC')!
    await selectTicker(chosen.symbol)
    expect(preferenceCollection.get('primary')).toMatchObject({
      selectedByUser: true, selectedSymbol: 'INTC',
    })

    // Signing in or out republishes the same tickers under a different watchlist id.
    await hydrateCollections({
      ...snapshot,
      watchlists: [{ id: 'public-options-watch', kind: 'public', name: 'Options Watch', symbols: snapshot.watchlists[0]!.symbols }],
    }, 'public')

    expect(preferenceCollection.get('primary')).toMatchObject({
      selectedByUser: true,
      selectedSymbol: 'INTC',
      selectedWatchlistId: 'public-options-watch',
    })
  })

  it('falls back to the busiest symbol only when the chosen one is gone', async () => {
    const snapshot = marketSnapshotFixture()
    await hydrateCollections(snapshot, 'owner')
    await selectTicker('INTC')

    const withoutIntc = snapshot.tickers.filter((ticker) => ticker.symbol !== 'INTC')
    await hydrateCollections({ ...snapshot, tickers: withoutIntc }, 'owner')

    const preference = preferenceCollection.get('primary')
    expect(preference?.selectedSymbol).not.toBe('INTC')
    expect(preference?.selectedByUser).toBe(false)
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
