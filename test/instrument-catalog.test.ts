import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  instrumentCatalogFromPayload,
  persistInstrumentCatalog,
  readInstrumentCatalog,
  refreshInstrumentCatalog,
  unresolvedInstrumentCatalogItem,
} from '../src/server/instrument-catalog'
import { sqliteD1 } from './sqlite-d1'

let migrations: string[]
let store: ReturnType<typeof sqliteD1>

beforeAll(async () => {
  migrations = await Promise.all([
    readFile(new URL('../migrations/0008_instrument_catalog.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0009_instrument_catalog_resolution.sql', import.meta.url), 'utf8'),
  ])
})

beforeEach(() => {
  store = sqliteD1(migrations)
})

afterEach(() => store.close())

function providerRow(symbol = 'SPCX') {
  return {
    active: true,
    'borrow-rate': '0.0375',
    'bypass-manual-review': false,
    'country-of-incorporation': 'United States',
    'country-of-taxation': 'United States',
    description: 'SpaceX Corporation',
    'halted-at': null,
    'instrument-sub-type': 'Common Stock',
    'instrument-type': 'Equity',
    'is-closing-only': false,
    'is-etf': false,
    'is-fractional-quantity-eligible': true,
    'is-illiquid': false,
    'is-index': false,
    'is-options-closing-only': false,
    lendability: 'Locate Required',
    'listed-market': 'NASDAQ',
    'market-time-instrument-collection': 'Equity',
    'option-tick-sizes': [
      { symbol, threshold: '3', value: '0.05' },
      { symbol, threshold: 'Infinity', value: '0.10' },
    ],
    'overnight-trading-permitted': true,
    'pre-ipo': false,
    'short-description': 'SpaceX',
    'stops-trading-at': '2026-12-31T21:00:00Z',
    'streamer-symbol': symbol,
    symbol,
    'tick-sizes': { symbol, threshold: '1', value: '0.01' },
    'underlying-product-type': 'Equity',
  }
}

describe('typed tastytrade instrument catalog', () => {
  it('extracts every interesting Equity field and never retains a raw payload', () => {
    const [item] = instrumentCatalogFromPayload(
      { data: { items: [providerRow()] } },
      ['SPCX'],
      new Date('2026-08-26T12:00:00.000Z'),
    )

    expect(item).toMatchObject({
      active: true,
      borrowRate: 0.0375,
      countryOfIncorporation: 'United States',
      description: 'SpaceX Corporation',
      instrumentSubType: 'Common Stock',
      identitySource: 'equity-endpoint',
      isEtf: false,
      lendability: 'Locate Required',
      listedMarket: 'NASDAQ',
      overnightTradingPermitted: true,
      resolutionStatus: 'resolved',
      shortDescription: 'SpaceX',
      symbol: 'SPCX',
    })
    expect(item?.tickSizes).toEqual([
      { appliesToSymbol: 'SPCX', kind: 'equity', threshold: 1, tierIndex: 0, value: 0.01 },
      { appliesToSymbol: 'SPCX', kind: 'option', threshold: 3, tierIndex: 0, value: 0.05 },
      { appliesToSymbol: 'SPCX', kind: 'option', threshold: null, tierIndex: 1, value: 0.1 },
    ])
    expect(JSON.stringify(item)).not.toContain('unmodeled-provider-field')
  })

  it('persists identity, daily status, and normalized tick tiers with stable creation time', async () => {
    const env = { DB: store.database }
    await refreshInstrumentCatalog(env, ['SPCX'], async () => ({ data: { items: [providerRow()] } }),
      new Date('2026-08-26T12:00:00.000Z'))
    const updated = providerRow()
    updated.description = 'Space Exploration Technologies Corp.'
    updated.active = false
    updated['option-tick-sizes'] = []
    await refreshInstrumentCatalog(env, ['SPCX'], async () => [updated],
      new Date('2026-08-27T12:00:00.000Z'))

    const item = (await readInstrumentCatalog(env, ['SPCX'])).get('SPCX')
    expect(item).toMatchObject({
      active: false,
      createdAt: '2026-08-26T12:00:00.000Z',
      description: 'Space Exploration Technologies Corp.',
      statusRefreshedAt: '2026-08-27T12:00:00.000Z',
      updatedAt: '2026-08-27T12:00:00.000Z',
    })
    expect(item?.tickSizes).toEqual([
      { appliesToSymbol: 'SPCX', kind: 'equity', threshold: 1, tierIndex: 0, value: 0.01 },
    ])
  })

  it('rejects provider rows for a different symbol or instrument type', () => {
    expect(() => instrumentCatalogFromPayload([providerRow('NVDA')], ['SPCX']))
      .toThrow('unexpected-symbol')
    expect(() => instrumentCatalogFromPayload([{ ...providerRow(), 'instrument-type': 'Equity Option' }], ['SPCX']))
      .toThrow('invalid-instrument-type')
  })

  it('represents a missing provider definition honestly without inventing a name or status', () => {
    expect(unresolvedInstrumentCatalogItem('VXD', new Date('2026-08-26T12:00:00.000Z'))).toMatchObject({
      active: null,
      description: null,
      identitySource: 'watchlist-symbol',
      resolutionStatus: 'unresolved',
      shortDescription: null,
      symbol: 'VXD',
    })
  })

  it('does not let a temporary unresolved result erase resolved identity or tick tiers', async () => {
    const env = { DB: store.database }
    await refreshInstrumentCatalog(env, ['SPCX'], async () => [providerRow()],
      new Date('2026-08-26T12:00:00.000Z'))
    await persistInstrumentCatalog(env, [
      unresolvedInstrumentCatalogItem('SPCX', new Date('2026-08-27T12:00:00.000Z')),
      unresolvedInstrumentCatalogItem('VXD', new Date('2026-08-27T12:00:00.000Z')),
    ])

    const catalog = await readInstrumentCatalog(env, ['SPCX', 'VXD'])
    expect(catalog.get('SPCX')).toMatchObject({
      description: 'SpaceX Corporation',
      identitySource: 'equity-endpoint',
      resolutionStatus: 'resolved',
      updatedAt: '2026-08-26T12:00:00.000Z',
    })
    expect(catalog.get('SPCX')?.tickSizes).toHaveLength(3)
    expect(catalog.get('VXD')).toMatchObject({
      description: null,
      identitySource: 'watchlist-symbol',
      resolutionStatus: 'unresolved',
    })
  })

  it('uses bounded multi-row writes and rejects an oversized persistence invocation', async () => {
    const env = { DB: store.database }
    const symbols = ['A', 'B', 'C', 'D']
    const items = instrumentCatalogFromPayload(symbols.map(providerRow), symbols)

    await persistInstrumentCatalog(env, items)

    expect((await readInstrumentCatalog(env, symbols)).size).toBe(4)
    await expect(persistInstrumentCatalog(env, Array.from(
      { length: 101 },
      (_, index) => unresolvedInstrumentCatalogItem(`Z${index}`.replace(/\d/g, 'A').slice(0, 8)),
    ))).rejects.toThrow('persist-chunk-too-large')
  })
})
