import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Ticker } from '../src/domain/market'
import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { D1_MAX_BOUND_PARAMETERS } from '../src/server/d1-limits'
import {
  persistTastytradeMarketSnapshot,
  type TastytradeMarketRecords,
} from '../src/server/tastytrade-market-store'
import { marketTickersFixture } from './fixtures/market'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

function sourceRecords(
  tickers: readonly Ticker[],
  previousClose = (ticker: Ticker) => ticker.price - ticker.change,
): TastytradeMarketRecords {
  return {
    metrics: tickers.map((ticker) => ({
      earningsDate: ticker.earningsDate,
      historicalVolatility30Day: ticker.historicalVolatility30Day,
      ivHistoricalVolatility30DayDifference: ticker.ivHistoricalVolatility30DayDifference,
      ivIndex: ticker.ivIndex,
      ivIndex5DayChange: ticker.ivIndex5DayChange,
      ivPercentile: ticker.ivPercentile,
      ivRank: ticker.ivRank,
      ivTermStructure: ticker.ivTermStructure,
      liquidity: ticker.liquidity,
      marketCap: ticker.marketCap,
      symbol: ticker.symbol,
    })),
    quotes: tickers.map((ticker) => ({
      previousClose: previousClose(ticker),
      price: ticker.price,
      providerUpdatedAt: ticker.updatedAt,
      symbol: ticker.symbol,
      volume: ticker.volume,
      yearHigh: ticker.yearHigh,
      yearLow: ticker.yearLow,
    })),
  }
}

describe('source-specific tastytrade market storage', () => {
  it('fails when source storage is unavailable', async () => {
    await expect(persistTastytradeMarketSnapshot(
      {},
      sourceRecords([marketTickersFixture[0]!]),
    )).rejects.toThrow('TastytradeMarketStore:unavailable')
  })

  it('keeps a full watchlist refresh below D1 query and bind limits', async () => {
    const boundParameterCounts: number[] = []
    const batch = vi.fn(async () => [])
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > D1_MAX_BOUND_PARAMETERS) throw new Error('too many SQL variables')
          return unsupportedStatement()
        },
      })),
    }
    const template = marketTickersFixture[0]!
    const tickers = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => ({
      ...template,
      name: `Ticker ${index}`,
      symbol: `T${index}`,
    }))

    await persistTastytradeMarketSnapshot({ DB: database }, sourceRecords(tickers))

    expect(batch).toHaveBeenCalledOnce()
    expect(boundParameterCounts.length).toBeGreaterThan(1)
    expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('keeps metrics and quotes separate while exposing a typed public view', async () => {
    store.sqlite.exec(`
      INSERT INTO instrument_catalog (
        symbol, description, instrument_type, active, is_etf, is_index,
        identity_refreshed_at, status_refreshed_at, created_at, updated_at
      ) VALUES (
        'NVDA', 'NVIDIA Corporation', 'Equity', 1, 0, 0,
        '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z',
        '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z'
      );
      INSERT INTO public_market_universe (id, payload_json, updated_at)
      VALUES ('primary', '{"symbols":["NVDA"]}', '2026-08-26T12:00:00.000Z');
    `)
    const ticker = marketTickersFixture.find((candidate) => candidate.symbol === 'NVDA')!

    await persistTastytradeMarketSnapshot(
      { DB: store.database },
      sourceRecords([ticker], () => 180),
      new Date('2026-08-26T20:00:00.000Z'),
    )

    expect(store.sqlite.prepare(
      'SELECT symbol, iv_rank_percent, market_cap, observed_at FROM tastytrade_market_metrics',
    ).get()).toEqual({
      iv_rank_percent: 72,
      market_cap: 4_730_000_000_000,
      observed_at: '2026-08-26T20:00:00.000Z',
      symbol: 'NVDA',
    })
    expect(store.sqlite.prepare(
      'SELECT symbol, previous_close, price, volume, provider_updated_at FROM tastytrade_market_quotes',
    ).get()).toEqual({
      price: 191.68,
      previous_close: 180,
      provider_updated_at: '2026-08-13T13:31:00.000Z',
      symbol: 'NVDA',
      volume: 128_400_000,
    })
    const overview = store.sqlite.prepare(
      `SELECT symbol, instrument_name, iv_rank_percent, market_cap, price,
        change_amount, change_percent, volume FROM public_market_overview`,
    ).get()
    expect(overview).toMatchObject({
      instrument_name: 'NVIDIA Corporation',
      iv_rank_percent: 72,
      market_cap: 4_730_000_000_000,
      price: 191.68,
      symbol: 'NVDA',
      volume: 128_400_000,
    })
    expect(overview?.change_amount).toBeCloseTo(11.68)
    expect(overview?.change_percent).toBeCloseTo(6.4888888889)
    expect(store.sqlite.prepare('PRAGMA table_info(tastytrade_market_metrics)').all().map((row) => row.name))
      .not.toContain('price')
    const quoteColumns = store.sqlite.prepare('PRAGMA table_info(tastytrade_market_quotes)').all()
      .map((row) => row.name)
    expect(quoteColumns).not.toContain('iv_rank_percent')
    expect(quoteColumns).not.toContain('change_amount')
    expect(quoteColumns).not.toContain('change_percent')
  })
})
