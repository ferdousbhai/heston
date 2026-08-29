import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubBrokerGate } from './broker-stub'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore } from './sqlite-d1'
import { ensureInternalWatchlistSeeded, finalizeInternalWatchlist } from '../src/server/internal-watchlist'
import { marketSnapshotFixture } from './fixtures/market'
import {
  loadStoredPublicMarketUniverse,
  publishInternalWatchlistUniverse,
} from '../src/server/public-market-universe'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

function storedCatalogRow(symbol: string) {
  return {
    active: 1,
    borrow_rate: null,
    bypass_manual_review: 0,
    country_of_incorporation: null,
    country_of_taxation: null,
    created_at: '2026-08-26T12:00:00.000Z',
    description: symbol,
    halted_at: null,
    identity_refreshed_at: '2026-08-26T12:00:00.000Z',
    identity_source: 'equity-endpoint',
    instrument_sub_type: null,
    instrument_type: 'Equity',
    is_closing_only: 0,
    is_etf: 0,
    is_fractional_quantity_eligible: null,
    is_illiquid: 0,
    is_index: 0,
    is_options_closing_only: 0,
    lendability: null,
    listed_market: null,
    market_time_instrument_collection: null,
    overnight_trading_permitted: null,
    pre_ipo: 0,
    resolution_status: 'resolved',
    short_description: null,
    source_name: 'tastytrade',
    status_refreshed_at: '2026-08-26T12:00:00.000Z',
    stops_trading_at: null,
    streamer_symbol: symbol,
    symbol,
    underlying_product_type: null,
    updated_at: '2026-08-26T12:00:00.000Z',
  }
}

function equitySymbolAt(index: number): string {
  let value = index + 1
  let symbol = ''
  while (value > 0) {
    value--
    symbol = String.fromCharCode(65 + value % 26) + symbol
    value = Math.floor(value / 26)
  }
  return symbol
}

describe('public market boundary', () => {
  it('rejects missing, malformed, and oversized stored universes', async () => {
    const store = await migrationStore()
    await expect(loadStoredPublicMarketUniverse({ DB: store.database })).rejects.toThrow('not-found')
    store.sqlite.prepare(
      `INSERT INTO public_market_universe (id, payload_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run(JSON.stringify({ symbols: ['not a ticker'] }), '2026-08-26T12:00:00.000Z')
    await expect(loadStoredPublicMarketUniverse({ DB: store.database })).rejects.toThrow()

    store.sqlite.prepare(`DELETE FROM public_market_universe WHERE id = 'primary'`).run()
    const symbols = Array.from({ length: 101 }, (_, index) => equitySymbolAt(index))
    const insert = store.sqlite.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES (?, 'Equity', 'owner', '{}', ?, ?)`,
    )
    for (const symbol of symbols) insert.run(symbol, '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z')
    await expect(publishInternalWatchlistUniverse({ DB: store.database })).rejects.toThrow()
    expect(store.sqlite.prepare(`SELECT id FROM public_market_universe WHERE id = 'primary'`).get()).toBeUndefined()
    store.close()
  })

  it('fails before provider access when the public D1 universe is unavailable', async () => {
    vi.resetModules()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'public-read-token', expires_in: 900 })
      if (url.includes('/market-time/equities/sessions/current')) return Response.json({ data: { state: 'Open' } })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadPublicMarketSnapshot } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const brokerGate = stubBrokerGate()

    await expect(loadPublicMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })).rejects.toThrow('PublicMarketUniverse:store-unavailable')

    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/accounts/'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/market-metrics'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/market-data'))).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not persist an unresolved catalog row for a provider transport failure', async () => {
    vi.resetModules()
    const store = await migrationStore()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'catalog-token', expires_in: 900 })
      if (url.includes('/instruments/equities?')) return Response.json({ data: { items: [] } })
      if (url.includes('/instruments/equities/SPCX')) return new Response('', { status: 500 })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { refreshTastytradeInstrumentCatalog } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }

    await expect(refreshTastytradeInstrumentCatalog({
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, ['SPCX'])).rejects.toThrow('TastytradeApi:500')
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM instrument_catalog').get()).toEqual({ count: 0 })
    store.close()
  })

  it('serves the internal list alone and never syncs a held symbol into it', async () => {
    vi.resetModules()
    const store = await migrationStore()
    store.sqlite.exec(`
      INSERT INTO internal_watchlist_seed
        (id, status, attempt_id, started_at, seeded_at, finalized_at)
      VALUES (
        'primary', 'ready', 'seed-1', '2026-08-26T10:00:00.000Z',
        '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z'
      );
      INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
      VALUES ('NVDA', 'Equity', 'tastytrade-seed', '{}', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z');
    `)
    const research = marketSnapshotFixture().research
    store.sqlite.prepare(
      'INSERT INTO research_briefs (id, published_at, payload_json) VALUES (?, ?, ?)',
    ).run(research.id, research.publishedAt, JSON.stringify(research))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'owner-read-token', expires_in: 900 })
      if (url.endsWith('/customers/me/accounts')) {
        return Response.json({ data: { items: [{ account: { 'account-number': 'TEST123' } }] } })
      }
      if (url.endsWith('/accounts/TEST123/positions')) {
        return Response.json({ data: { items: [{ symbol: 'META', quantity: '1' }] } })
      }
      if (url.includes('/market-time/equities/sessions/current')) {
        return Response.json({ data: { state: 'Open', 'open-at': '2026-08-26T13:30:00.000Z' } })
      }
      const symbols = ['META', 'NVDA']
      if (url.includes('/market-metrics')) return Response.json({ data: { items: symbols.map((symbol) => ({
        symbol,
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.55',
        'implied-volatility-percentile': '0.61',
        'liquidity-rating': '4',
      })) } })
      if (url.includes('/market-data/by-type')) return Response.json({ data: { items: symbols.map((symbol) => ({
        symbol, mark: '100', 'previous-close': '98', description: symbol,
        change: '2', 'change-percent': '2.0408163265',
        'updated-at': '2026-08-26T13:31:00.000Z',
      })) } })
      if (url.includes('/instruments/equities')) return Response.json({ data: { items: symbols.map((symbol) => ({
        active: true, description: symbol, 'instrument-type': 'Equity', symbol,
      })) } })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { brokerApi } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const brokerGate = stubBrokerGate()

    const snapshot = await brokerApi().loadMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    expect(snapshot.watchlists).toEqual([
      { id: 'watchlist', kind: 'private', name: 'Watchlist', symbols: ['NVDA'] },
    ])
    expect(snapshot.tickers.find((ticker) => ticker.symbol === 'META')?.position).toBe(true)
    expect(store.sqlite.prepare(
      `SELECT origin FROM internal_watchlist_items WHERE symbol = 'META'`,
    ).get()).toBeUndefined()
    expect(JSON.parse(String(store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()?.payload_json))).toEqual({ symbols: ['NVDA'] })
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/accounts/TEST123/positions'))).toBe(true)
    store.close()
  })

  it('reduces a restored seed universe when the owner has no active positions', async () => {
    vi.resetModules()
    const store = await migrationStore()
    const symbols = Array.from({ length: 105 }, (_, index) => equitySymbolAt(index))
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => ({
      privatePayload: [{
        name: 'Legacy private list',
        'watchlist-entries': symbols.map((symbol) => ({ symbol, 'instrument-type': 'Equity' })),
      }],
      publicPayload: [],
    }))
    await finalizeInternalWatchlist(env, [])
    const research = marketSnapshotFixture().research
    store.sqlite.prepare(
      'INSERT INTO research_briefs (id, published_at, payload_json) VALUES (?, ?, ?)',
    ).run(research.id, research.publishedAt, JSON.stringify(research))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'owner-read-token', expires_in: 900 })
      if (url.pathname.endsWith('/customers/me/accounts')) {
        return Response.json({ data: { items: [{ account: { 'account-number': 'TEST123' } }] } })
      }
      if (url.pathname.endsWith('/accounts/TEST123/positions')) return Response.json({ data: { items: [] } })
      if (url.pathname.includes('/market-time/equities/sessions/current')) {
        return Response.json({ data: { state: 'Open' } })
      }
      if (url.pathname.endsWith('/instruments/equities')) {
        return Response.json({ data: { items: url.searchParams.getAll('symbol[]').map((symbol) => ({
          active: true, description: symbol, 'instrument-type': 'Equity', symbol,
        })) } })
      }
      if (url.pathname.endsWith('/market-metrics')) {
        return Response.json({ data: { items: (url.searchParams.get('symbols') ?? '').split(',').map((symbol) => ({
          symbol,
          'implied-volatility-index': '0.42',
          'implied-volatility-index-rank': '0.55',
          'implied-volatility-percentile': '0.61',
          'liquidity-rating': '4',
        })) } })
      }
      if (url.pathname.endsWith('/market-data/by-type')) {
        return Response.json({ data: { items: url.searchParams.getAll('equity').map((symbol) => ({
          symbol, mark: '100', 'previous-close': '98', description: symbol,
          change: '2', 'change-percent': '2.0408163265',
          'updated-at': '2026-08-26T13:31:00.000Z',
        })) } })
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { brokerApi } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const brokerGate = stubBrokerGate()

    const snapshot = await brokerApi().loadMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    expect(snapshot.watchlists).toHaveLength(1)
    expect(snapshot.watchlists[0]?.symbols).toHaveLength(100)
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_items').get())
      .toEqual({ count: 100 })
    expect(JSON.parse(String(store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()?.payload_json)).symbols).toHaveLength(100)
    store.close()
  })

  it('loads the stored source-free universe through market-only endpoints', async () => {
    vi.resetModules()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'public-read-token', expires_in: 900 })
      if (url.includes('/market-time/equities/sessions/current')) return Response.json({ data: { state: 'Open' } })
      if (url.includes('/market-metrics')) return Response.json({ data: { items: ['BE', 'NVDA'].map((symbol) => ({
        symbol,
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.55',
        'implied-volatility-percentile': '0.61',
        'liquidity-rating': '4',
      })) } })
      if (url.includes('/market-data/by-type')) return Response.json({ data: { items: ['BE', 'NVDA'].map((symbol) => ({
        symbol, mark: '100', 'previous-close': '98', description: symbol,
        change: '2', 'change-percent': '2.0408163265',
        'updated-at': '2026-08-26T13:31:00.000Z',
      })) } })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const db: D1Database = {
      ...unsupportedDatabase(),
      batch: async (statements) => statements.map(() => d1Result([])),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        first: async () => {
          if (sql.includes('FROM public_market_universe')) {
            return { payload_json: JSON.stringify({ symbols: ['BE', 'NVDA'] }) }
          }
          if (sql.includes('FROM research_briefs')) {
            return { payload_json: JSON.stringify(marketSnapshotFixture().research) }
          }
          throw new Error(`Unexpected first query: ${sql}`)
        },
        bind: () => ({
          ...unsupportedStatement(),
          all: async <T>() => {
            if (sql.includes('FROM upcoming_catalysts')) return d1Result<T>([])
            if (sql.includes('FROM instrument_catalog')) {
              const rows = ['BE', 'NVDA'].map(storedCatalogRow)
              // SAFETY: this branch exactly models the catalog row selected by production SQL.
              return d1Result(rows as T[])
            }
            if (sql.includes('FROM instrument_tick_sizes')) return d1Result<T>([])
            throw new Error(`Unexpected all query: ${sql}`)
          },
        }),
      }),
    }
    const { loadPublicMarketSnapshot } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const brokerGate = stubBrokerGate()

    const snapshot = await loadPublicMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: db,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    expect(snapshot.watchlists[0]?.symbols).toEqual(['BE', 'NVDA'])
    expect(snapshot.tickers).toEqual([
      expect.objectContaining({ symbol: 'BE', position: false }),
      expect.objectContaining({ symbol: 'NVDA', position: false }),
    ])
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/accounts/') || url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/instruments/equities'))).toBe(false)
  })
})
