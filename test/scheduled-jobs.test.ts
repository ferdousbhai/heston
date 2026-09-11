import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_LIVE_STREAM_SYMBOLS, MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { type AppEnv } from '../src/server/env'
import { ensureInternalWatchlistSeeded, finalizeInternalWatchlist } from '../src/server/internal-watchlist'
import { refreshYearCandles } from '../src/server/scheduled-jobs'
import { readYearCandleSeries } from '../src/server/year-candle-store'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

function symbolAt(index: number): string {
  let value = index + 1
  let symbol = ''
  while (value > 0) {
    value--
    symbol = String.fromCharCode(65 + value % 26) + symbol
    value = Math.floor(value / 26)
  }
  return symbol
}

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
  // The watchlist grows on its own through visitor search, so it reaches its 500-symbol bound
  // without anyone deciding to grow it. Asking the feed for that many refused the whole
  // refresh — the DXLink subscription admits a hundred — and the year chart would have gone
  // stale silently the first time the list passed a hundred names.
  it('asks the feed for no more symbols than one subscription may carry', async () => {
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
    expect(requested).toHaveLength(MAX_LIVE_STREAM_SYMBOLS)
    expect(count).toBe(MAX_LIVE_STREAM_SYMBOLS)
    const stored = await readYearCandleSeries(store.database)
    expect(stored.asOf).toBe('2026-09-07')
    expect(stored.series.get(requested[0]!)).toEqual([100])
  })
})
