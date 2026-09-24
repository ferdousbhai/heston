import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { type AppEnv } from '../src/server/env'
import { MAX_DAILY_CANDLE_SYMBOLS } from '../src/server/market-feed-contracts'
import { publishInternalWatchlistUniverse } from '../src/server/public-market-universe'
import { refreshYearCandles, yearCandleRefreshEvent } from '../src/server/scheduled-jobs'
import { readYearAgoCloses, readYearCandleSeries, replaceYearCandles } from '../src/server/year-candle-store'
import { migrationStore, seededItems, seedWatchlist, type SqliteD1Store } from './sqlite-d1'
import { symbolAt } from './symbols'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

/** Fill the watchlist to its own bound, which is five times what one feed read may subscribe. */
async function seededWatchlist(): Promise<void> {
  seedWatchlist(store, seededItems(Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))))
  await publishInternalWatchlistUniverse({ DB: store.database })
}

function storeVolume(symbol: string, volume: number | null): void {
  store.sqlite.prepare(
    `INSERT INTO tastytrade_market_quotes
       (symbol, price, previous_close, volume, provider_updated_at, observed_at)
     VALUES (?, 10, 10, ?, '2026-09-04T20:00:00.000Z', '2026-09-04T20:00:00.000Z')`,
  ).run(symbol, volume)
}

/** The symbols one refresh asks the feed for. */
async function requestedYearSymbols(): Promise<readonly string[]> {
  const readDailyCandles = vi.fn(async (symbols: readonly string[]) => ({
    asOf: '2026-09-07T13:30:00.000Z',
    series: symbols.map((symbol) => ({ symbol, closes: [] })),
    source: 'tastytrade-dxlink' as const,
  }))
  await refreshYearCandles({
    DB: store.database,
    MARKET_FEED: { getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })) },
  }, new Date('2026-09-07T13:30:00.000Z'))
  return readDailyCandles.mock.calls[0]![0]
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
    await seededWatchlist()
    const env: AppEnv = {
      DB: store.database,
      MARKET_FEED: {
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
      },
    }

    const refresh = await refreshYearCandles(env, new Date('2026-09-07T13:30:00.000Z'))

    const requested = readDailyCandles.mock.calls[0]![0]
    expect(requested).toHaveLength(MAX_DAILY_CANDLE_SYMBOLS)
    expect(refresh).toEqual({ status: 'refreshed', symbolCount: MAX_DAILY_CANDLE_SYMBOLS })
    expect(yearCandleRefreshEvent(refresh)).toEqual({ event: 'YearCandlesRefreshed', symbolCount: MAX_DAILY_CANDLE_SYMBOLS })
    const stored = await readYearCandleSeries(store.database, requested)
    expect(stored.asOf).toBe('2026-09-07')
    expect(stored.series.get(requested[0]!)).toEqual([100])
  })

  it('counts only the symbols whose series arrived with closes', async () => {
    await seededWatchlist()
    const readDailyCandles = vi.fn(async (symbols: readonly string[]) => ({
      asOf: '2026-09-07T13:30:00.000Z',
      series: symbols.map((symbol, index) => ({
        symbol,
        closes: index === 0 ? [] : [{ time: 1_786_000_000_000, sequence: 0, close: 100 }],
      })),
      source: 'tastytrade-dxlink' as const,
    }))
    const env: AppEnv = {
      DB: store.database,
      MARKET_FEED: {
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
      },
    }

    const refresh = await refreshYearCandles(env, new Date('2026-09-07T13:30:00.000Z'))

    expect(refresh).toEqual({ status: 'refreshed', symbolCount: MAX_DAILY_CANDLE_SYMBOLS - 1 })
  })

  it('retires the year row of a symbol that fell out of the refreshed focus', async () => {
    await seededWatchlist()
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
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
      },
    }

    await refreshYearCandles(env, new Date('2026-09-07T13:30:00.000Z'))

    expect(readDailyCandles.mock.calls[0]![0]).not.toContain(outside)
    await expect(readYearAgoCloses(store.database, [outside])).resolves.toEqual(new Map())
  })

  // Which names carry a year series is public, so the budget must not be the head of the
  // private ranking: an owner addition or a private broker list would show through it.
  it('chooses the budgeted names by public volume, independent of private rank or origin', async () => {
    const symbols = Array.from({ length: MAX_DAILY_CANDLE_SYMBOLS * 2 }, (_, index) => symbolAt(index))
    // Volume rises with the index, so the highest-volume half is the second half; the first
    // name has no volume and the last two tie.
    symbols.forEach((symbol, index) => storeVolume(symbol, index === 0 ? null : Math.min(index, symbols.length - 2)))
    const busiest = symbols.slice(MAX_DAILY_CANDLE_SYMBOLS)
    const expected = [...busiest.slice(-2).sort(), ...busiest.slice(0, -2).reverse()]

    // The private ranking puts the quiet half first: owner additions and a private broker list.
    const quiet = symbols.slice(0, MAX_DAILY_CANDLE_SYMBOLS)
    seedWatchlist(
      store,
      symbols.map((symbol, index) => ({ origin: index < 10 ? 'owner' as const : undefined, symbol })),
      [{ entries: quiet.map((symbol) => ({ instrumentType: 'Equity', symbol })), kind: 'private', name: 'Private' }],
    )
    await publishInternalWatchlistUniverse({ DB: store.database })
    const chosen = await requestedYearSymbols()
    expect(chosen).toEqual(expected)

    // Promote a different set of names privately; the public choice does not move.
    store.sqlite.prepare("UPDATE internal_watchlist_items SET origin = 'trade-intent' WHERE symbol IN (?, ?, ?)")
      .run(symbols[1], symbols[2], symbols[3])
    store.sqlite.prepare("UPDATE internal_watchlist_items SET origin = 'visitor-search' WHERE origin = 'owner'").run()
    await publishInternalWatchlistUniverse({ DB: store.database })
    await expect(requestedYearSymbols()).resolves.toEqual(chosen)
  })

  it('falls back to the alphabet for names with no stored volume', async () => {
    seedWatchlist(store, seededItems(['MSFT', 'AAPL', 'ZM']))
    await publishInternalWatchlistUniverse({ DB: store.database })
    storeVolume('ZM', 5)
    await expect(requestedYearSymbols()).resolves.toEqual(['ZM', 'AAPL', 'MSFT'])
  })

  it('skips the off-season UTC fire rather than subscribing twice', async () => {
    const readDailyCandles = vi.fn()
    const env: AppEnv = {
      DB: store.database,
      MARKET_FEED: {
        getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles, readOptionGreeks: vi.fn() })),
      },
    }

    const refresh = await refreshYearCandles(env, new Date('2026-09-16T14:30:00.000Z'))
    expect(readDailyCandles).not.toHaveBeenCalled()
    // A skip logs as a skip, never as a refresh that stored nothing.
    expect(refresh).toEqual({ reason: 'not-cash-open', status: 'skipped' })
    expect(yearCandleRefreshEvent(refresh)).toEqual({ event: 'YearCandlesRefreshSkipped', reason: 'not-cash-open' })
  })

  it('names a missing binding instead of reporting an empty refresh', async () => {
    const open = new Date('2026-09-07T13:30:00.000Z')
    const feed = { getByName: vi.fn(() => ({ fetch: vi.fn(), readDailyCandles: vi.fn(), readOptionGreeks: vi.fn() })) }
    await expect(refreshYearCandles({ MARKET_FEED: feed }, open))
      .rejects.toMatchObject({ name: 'BindingMissing', message: 'BindingMissing:DB' })
    await expect(refreshYearCandles({ DB: store.database }, open))
      .rejects.toMatchObject({ name: 'BindingMissing', message: 'BindingMissing:MARKET_FEED' })
    // The off-season fire stays a deliberate no-op, binding or not.
    await expect(refreshYearCandles({}, new Date('2026-09-16T14:30:00.000Z')))
      .resolves.toEqual({ reason: 'not-cash-open', status: 'skipped' })
  })
})
