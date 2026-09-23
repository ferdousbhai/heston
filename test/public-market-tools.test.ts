import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PublicMarketSnapshotSchema } from '../src/domain/market'
import {
  createPublicMarketReadTools,
  PublicSymbolSearchError,
  selectPublicQuoteRows,
} from '../src/server/public-market-tools'
import { MAX_QUERY_LENGTH } from '../src/server/symbol-search'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

describe('anonymous public quote projection', () => {
  it('reads requested rows without parsing the rest of the website book', () => {
    const snapshot = {
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [
        { symbol: 'AAPL', price: 236.41, change: -1.84, changePercent: -0.77, name: 'Apple' },
        { symbol: 'NVDA', price: 191.68, change: 4.91, changePercent: 2.63, ivRank: 72, ivPercentile: 81, ivIndex: 48.2, marketCap: 4_730_000_000_000 },
      ],
    }
    expect(() => PublicMarketSnapshotSchema.parse(snapshot)).toThrow()

    const projected = selectPublicQuoteRows(snapshot, ['nvda', 'XOM'])
    expect(projected.syncedAt).toBe(snapshot.syncedAt)
    expect(projected.missing).toEqual(['XOM'])
    expect(projected.rows).toEqual([{
      change: 4.91,
      changePercent: 2.63,
      ivIndex: 48.2,
      ivPercentile: 81,
      ivRank: 72,
      marketCap: 4_730_000_000_000,
      price: 191.68,
      symbol: 'NVDA',
    }])
  })

  it('fails closed on a requested row that is not a quote', () => {
    expect(() => selectPublicQuoteRows({
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [{ symbol: 'NVDA', price: '191.68', change: 4.91, changePercent: 2.63 }],
    }, ['NVDA'])).toThrow()
  })

  it('ignores a malformed row the caller did not ask for', () => {
    const projected = selectPublicQuoteRows({
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [
        { symbol: 'AAPL' },
        { symbol: 'NVDA', price: 191.68, change: 4.91, changePercent: 2.63 },
      ],
    }, ['NVDA'])
    expect(projected.rows).toHaveLength(1)
    expect(projected.rows[0]?.symbol).toBe('NVDA')
  })
})

describe('anonymous symbol search', () => {
  // The real search route behind the tool, over a stub broker and an edge cache that holds
  // nothing, so each call reaches the route's own answer.
  const broker = stubBroker()

  beforeEach(() => {
    vi.clearAllMocks()
    setBrokerApi(broker)
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } })
  })

  afterEach(() => {
    resetBrokerApi()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function searchTool() {
    const tool = createPublicMarketReadTools({ AUTH_BASE_URL: 'https://heston.test' }, () => undefined)
      .find((candidate) => candidate.name === 'search_symbols')
    if (!tool) throw new Error('search_symbols is missing')
    return tool
  }

  it('advertises the search route\'s own query bound', () => {
    expect(searchTool().parameters).toMatchObject({ properties: { query: { maxLength: MAX_QUERY_LENGTH } } })
  })

  it('reports a clean miss as a result', async () => {
    broker.lookupPublicMarketSymbol.mockResolvedValue(undefined)
    const result = await searchTool().execute({ query: 'ZZZZ' })
    expect(result.details).toEqual({ error: 'No tradable symbol matches that search' })
  })

  it('fails visibly rather than returning a refused query as a search result', async () => {
    // Only wildcards: the route refuses it with a 400 before any lookup.
    await expect(searchTool().execute({ query: '%%' })).rejects.toBeInstanceOf(PublicSymbolSearchError)
  })

  it('fails visibly rather than returning an outage as a search result', async () => {
    broker.lookupPublicMarketSymbol.mockRejectedValue(new Error('ProviderDown'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(searchTool().execute({ query: 'NVDA' })).rejects.toBeInstanceOf(PublicSymbolSearchError)
  })
})
