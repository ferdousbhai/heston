import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { type AppEnv } from '../src/server/env'
import { ensureInternalWatchlistSeeded, finalizeInternalWatchlist } from '../src/server/internal-watchlist'
import { MAX_DAILY_CANDLE_SYMBOLS } from '../src/server/market-feed-contracts'
import { refreshYearCandles } from '../src/server/scheduled-jobs'
import { readYearAgoCloses, readYearCandleSeries, replaceYearCandles } from '../src/server/year-candle-store'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'
import { symbolAt } from './symbols'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

/** Fill the watchlist to its own bound, which is five times what one feed read may subscribe. */
async function seededWatchlist(database: D1Database): Promise<void> {
  const symbols = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))
  await ensureInternalWatchlistSeeded({ DB: database }, async () => ({
    privatePayload: [{
      name: 'Legacy private list',
      'watchlist-entries': symbols.map((symbol) => ({ symbol, 'instrument-type': 'Equity' })),
    }],
    publicPayload: [],
  }))
  await finalizeInternalWatchlist({ DB: database }, [])
}

describe('year candle refresh', () => {
  // The watchlist grows on its own through visitor search, so it reaches `MAX_WATCHLIST_SYMBOLS`
  // without anyone deciding to grow it. Asking the feed for that many refused the whole
  // refresh — one year read admits `MAX_DAILY_CANDLE_SYMBOLS` — and the year chart would have
  // gone stale silently the first time the list outgrew the read.
  it('asks the feed for no more symbols than one year read may carry', async () => {
    const readDailyCandles = vi.fn(async (symbols: readonly string[]) => ({
      asOf: '2026-09-07T13:30:00.000Z',
      series: symbols.map((symbol) => ({ symbol, closes: [{ time: 1_786_000_000_000, sequence: 0, close: 100 }] })),
      source: 'tastytrade-dxlink' as const,
    }))
    await seededWatchlist(store.database)
    const env: AppEnv = {
      DB: store.database,
      MARKET_FEED: {
        get: vi.fn(),
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
        idFromName: vi.fn(),
      },
    }

    const count = await refreshYearCandles(env, new Date('2026-09-07T13:30:00.000Z'))

    const requested = readDailyCandles.mock.calls[0]![0]
    expect(requested).toHaveLength(MAX_DAILY_CANDLE_SYMBOLS)
    expect(count).toBe(MAX_DAILY_CANDLE_SYMBOLS)
    const stored = await readYearCandleSeries(store.database, requested)
    expect(stored.asOf).toBe('2026-09-07')
    expect(stored.series.get(requested[0]!)).toEqual([100])
  })

  it('retires the year row of a symbol that fell out of the refreshed focus', async () => {
    await seededWatchlist(store.database)
    const outside = symbolAt(MAX_WATCHLIST_SYMBOLS - 1)
    await replaceYearCandles(store.database, '2026-09-04', [outside], new Map([[outside, [{ time: 1, sequence: 0, close: 50 }]]]))
    const readDailyCandles = vi.fn(async (symbols: readonly string[]) => ({
      asOf: '2026-09-07T13:30:00.000Z',
      series: symbols.map((symbol) => ({ symbol, closes: [{ time: 1_786_000_000_000, sequence: 0, close: 100 }] })),
      source: 'tastytrade-dxlink' as const,
    }))
    const env: AppEnv = {
      DB: store.database,
      MARKET_FEED: {
        get: vi.fn(),
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
        idFromName: vi.fn(),
      },
    }

    await refreshYearCandles(env, new Date('2026-09-07T13:30:00.000Z'))

    expect(readDailyCandles.mock.calls[0]![0]).not.toContain(outside)
    await expect(readYearAgoCloses(store.database, [outside])).resolves.toEqual(new Map())
  })

  it('skips the off-season UTC fire rather than subscribing twice', async () => {
    const readDailyCandles = vi.fn()
    const env: AppEnv = {
      DB: store.database,
      MARKET_FEED: {
        get: vi.fn(),
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
        idFromName: vi.fn(),
      },
    }

    expect(await refreshYearCandles(env, new Date('2026-09-16T14:30:00.000Z'))).toBe(0)
    expect(readDailyCandles).not.toHaveBeenCalled()
  })
})
