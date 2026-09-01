import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { tickerFromStoredRecords } from '../src/server/tastytrade-market-normalization'
import {
  claimMarketRefresh,
  persistMarketSession,
  persistTastytradeMarketSnapshot,
  readStoredMarketRecords,
  readStoredMarketSession,
} from '../src/server/tastytrade-market-store'
import { unsupportedDatabase } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const metric = {
  earningsDate: '2026-10-29',
  ivIndex: 27.4,
  ivRank: 46,
  ivTermStructure: {
    backExpiration: '2026-09-11',
    backIv: 26.1,
    frontExpiration: '2026-09-04',
    frontIv: 28.9,
  },
  liquidity: 5,
  marketCap: 3_500_000_000_000,
  symbol: 'AAPL',
}

const quote = {
  previousClose: 238.25,
  price: 236.41,
  providerUpdatedAt: '2026-08-28T13:31:00.000Z',
  symbol: 'AAPL',
  volume: 44_000_000,
  yearHigh: 260.1,
  yearLow: 164.08,
}

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

describe('stored market read model', () => {
  it('round-trips what the writer persisted back into a renderable ticker', async () => {
    const env = { DB: store.database }
    await persistTastytradeMarketSnapshot(env, { metrics: [metric], quotes: [quote] })

    const records = await readStoredMarketRecords(env, ['AAPL', 'NVDA'])
    expect(records.metrics.get('AAPL')).toEqual(metric)
    expect(records.quotes.get('AAPL')).toEqual(quote)
    expect(records.observedAt).toBeDefined()
    // A symbol the store has never seen is absent rather than a zero-priced row.
    expect(records.quotes.get('NVDA')).toBeUndefined()

    const ticker = tickerFromStoredRecords(
      'AAPL',
      records.metrics.get('AAPL'),
      records.quotes.get('AAPL')!,
      true,
      { description: 'Apple', 'is-etf': false, 'is-index': false, lendability: 'Easy To Borrow' },
    )
    expect(ticker).toMatchObject({
      assetType: 'stock',
      change: 236.41 - 238.25,
      earningsDate: '2026-10-29',
      lendability: 'Easy To Borrow',
      marketCap: 3_500_000_000_000,
      name: 'Apple',
      position: true,
      price: 236.41,
      symbol: 'AAPL',
      updatedAt: '2026-08-28T13:31:00.000Z',
    })
    // Candle history is live-only state and is never reconstructed from the store.
    expect(ticker.sparkline).toEqual([])
    expect(ticker.changePercent).toBeCloseTo(((236.41 - 238.25) / 238.25) * 100, 10)
  })

  it('grants the refresh claim to one caller and releases it only by expiry', async () => {
    const env = { DB: store.database }
    const now = new Date('2026-08-28T13:31:00.000Z')

    const claims = await Promise.all([
      claimMarketRefresh(env, 30_000, now),
      claimMarketRefresh(env, 30_000, now),
      claimMarketRefresh(env, 30_000, now),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)

    // Still held part-way through the lease, so a later visitor does not pile on a second refresh.
    await expect(claimMarketRefresh(env, 30_000, new Date(now.getTime() + 29_000))).resolves.toBe(false)
    // A refresh that died mid-flight cannot wedge the lease shut.
    await expect(claimMarketRefresh(env, 30_000, new Date(now.getTime() + 31_000))).resolves.toBe(true)
  })

  it('grants a claim per resource so one symbol lookup cannot block another', async () => {
    const env = { DB: store.database }
    const now = new Date('2026-08-28T13:31:00.000Z')

    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:AAPL')).resolves.toBe(true)
    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:AAPL')).resolves.toBe(false)
    // A different resource is unaffected, and needs no seeded row to be claimable.
    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:NVDA')).resolves.toBe(true)
  })

  it('grants the claim when the store cannot answer, rather than denying every visitor', async () => {
    // The lease only exists to spare the provider. A store outage or a schema still catching
    // up must degrade to one extra refresh, never to a public page that cannot be served.
    // Every call on this database throws, which is how a missing table or a D1 outage reads.
    const unavailable = unsupportedDatabase()

    await expect(claimMarketRefresh({ DB: unavailable }, 30_000)).resolves.toBe(true)
    await expect(claimMarketRefresh({}, 30_000)).resolves.toBe(true)
  })

  it('caches the provider session state for visitors that never call the provider', async () => {
    const env = { DB: store.database }
    await expect(readStoredMarketSession(env)).resolves.toBeUndefined()

    await persistMarketSession(env, 'pre', '2026-08-28T13:30:00.000Z', new Date('2026-08-28T11:00:00.000Z'))
    await expect(readStoredMarketSession(env)).resolves.toEqual({
      observedAt: '2026-08-28T11:00:00.000Z',
      opensAt: '2026-08-28T13:30:00.000Z',
      state: 'pre',
    })

    // A session with no opening bell to report leaves the countdown with nothing to count.
    await persistMarketSession(env, 'closed', undefined, new Date('2026-08-28T20:01:00.000Z'))
    await expect(readStoredMarketSession(env)).resolves.toEqual({
      observedAt: '2026-08-28T20:01:00.000Z',
      opensAt: undefined,
      state: 'closed',
    })
  })
})
