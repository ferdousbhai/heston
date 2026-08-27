import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { persistTastytradeMarketSnapshot } from '../src/server/tastytrade-market-store'
import { marketTickersFixture } from './fixtures/market'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { sqliteD1 } from './sqlite-d1'

let migrations: string[]
let store: ReturnType<typeof sqliteD1>

beforeAll(async () => {
  const names = [
    'spice', 'scheduled_runs', 'public_market_universe', 'catalyst_description',
    'brokerage_action_state', 'internal_watchlist', 'internal_watchlist_validation',
    'instrument_catalog', 'instrument_catalog_resolution', 'source_specific_market_data',
    'internal_watchlist_position_origin', 'codex_catalyst_confidence',
  ]
  migrations = await Promise.all(names.map((name, index) => readFile(
    new URL(`../migrations/${String(index + 1).padStart(4, '0')}_${name}.sql`, import.meta.url),
    'utf8',
  )))
})

beforeEach(() => {
  store = sqliteD1(migrations)
})

afterEach(() => store.close())

describe('source-specific tastytrade market storage', () => {
  it('keeps a 100-symbol refresh below D1 query and bind limits', async () => {
    const boundParameterCounts: number[] = []
    let batchStatementCount = 0
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      batchStatementCount = statements.length
      return []
    })
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > 100) throw new Error('too many SQL variables')
          return unsupportedStatement()
        },
      })),
    }
    const template = marketTickersFixture[0]!
    const tickers = Array.from({ length: 100 }, (_, index) => ({
      ...template,
      name: `Ticker ${index}`,
      symbol: `T${index}`,
    }))

    await persistTastytradeMarketSnapshot({ DB: database }, tickers)

    expect(batch).toHaveBeenCalledOnce()
    expect(batchStatementCount).toBe(27)
    expect(Math.max(...boundParameterCounts)).toBe(100)
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
      [ticker],
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
      'SELECT symbol, price, volume, provider_updated_at FROM tastytrade_market_quotes',
    ).get()).toEqual({
      price: 191.68,
      provider_updated_at: '2026-08-13T13:31:00.000Z',
      symbol: 'NVDA',
      volume: 128_400_000,
    })
    expect(store.sqlite.prepare(
      'SELECT symbol, instrument_name, iv_rank_percent, market_cap, price, volume FROM public_market_overview',
    ).get()).toEqual({
      instrument_name: 'NVIDIA Corporation',
      iv_rank_percent: 72,
      market_cap: 4_730_000_000_000,
      price: 191.68,
      symbol: 'NVDA',
      volume: 128_400_000,
    })
    expect(store.sqlite.prepare('PRAGMA table_info(tastytrade_market_metrics)').all().map((row) => row.name))
      .not.toContain('price')
    expect(store.sqlite.prepare('PRAGMA table_info(tastytrade_market_quotes)').all().map((row) => row.name))
      .not.toContain('iv_rank_percent')
  })
})
