import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { stubBrokerGate } from './broker-stub'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { marketSnapshotFixture } from './fixtures/market'
import { sqliteD1 } from './sqlite-d1'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('public market boundary', () => {
  it('bounds oversized private universes deterministically without source-priority ordering', async () => {
    const symbols = Array.from({ length: 120 }, (_, index) => {
      const first = String.fromCharCode(65 + Math.floor(index / 26))
      const second = String.fromCharCode(65 + (index % 26))
      return `${first}${second}`
    })
    const snapshot = marketSnapshotFixture()
    snapshot.watchlists = [
      { id: 'positions', kind: 'positions', name: 'Active Positions', symbols: symbols.slice(0, 60).reverse() },
      { id: 'watchlist', kind: 'private', name: 'Watchlist', symbols: symbols.slice(60).reverse() },
    ]
    const { publicMarketUniverseFromSnapshot } = await import('../src/server/tastytrade')

    expect(publicMarketUniverseFromSnapshot(snapshot).symbols).toEqual([...symbols].sort().slice(0, 100))
  })

  it('has no hardcoded fallback and never reaches an account or watchlist endpoint', async () => {
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

    const snapshot = await loadPublicMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/accounts/'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/market-metrics'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/market-data'))).toBe(false)
    expect(snapshot.watchlists).toEqual([{
      id: 'public-options-watch', kind: 'public', name: 'Options Watch', symbols: [],
    }])
    expect(snapshot.tickers).toEqual([])
  })

  it('loads owner positions plus the internal list without recurring tastytrade watchlist reads', async () => {
    vi.resetModules()
    const migrationUrls = [
      '../migrations/0001_spice.sql',
      '../migrations/0003_public_market_universe.sql',
      '../migrations/0004_catalyst_description.sql',
      '../migrations/0006_internal_watchlist.sql',
    ]
    const migrations = await Promise.all(migrationUrls.map((url) => readFile(new URL(url, import.meta.url), 'utf8')))
    const store = sqliteD1(migrations)
    store.sqlite.exec(`
      INSERT INTO internal_watchlist_seed
        (id, status, attempt_id, started_at, seeded_at)
      VALUES ('primary', 'ready', 'seed-1', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z');
      INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
      VALUES ('NVDA', 'Equity', 'tastytrade-seed', '{}', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z');
    `)
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
        'updated-at': '2026-08-26T13:31:00.000Z',
      })) } })
      if (url.includes('/instruments/equities')) return Response.json({ data: { items: symbols.map((symbol) => ({ symbol, description: symbol })) } })
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
      { id: 'positions', kind: 'positions', name: 'Active Positions', symbols: ['META'] },
      { id: 'watchlist', kind: 'private', name: 'Watchlist', symbols: ['NVDA'] },
    ])
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/accounts/TEST123/positions'))).toBe(true)
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
        'updated-at': '2026-08-26T13:31:00.000Z',
      })) } })
      // Instrument descriptions are optional enrichment. A malformed successful
      // catalog response must still leave quote descriptions usable.
      if (url.includes('/instruments/equities')) return Response.json({ data: { unexpected: true } })
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
          if (sql.includes('FROM research_briefs')) return null
          throw new Error(`Unexpected first query: ${sql}`)
        },
        bind: () => ({
          ...unsupportedStatement(),
          all: async () => {
            if (sql.includes('FROM catalysts')) return d1Result([])
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
    expect(requestedUrls.some((url) => url.includes('/instruments/equities')
      && url.includes('symbol[]=BE') && url.includes('symbol[]=NVDA'))).toBe(true)
  })
})
