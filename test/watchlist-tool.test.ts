import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadBrokerageContext } from '../src/server/brokerage-context'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { createWatchlistReadTool } from '../src/server/watchlist-tool'
import { brokerCredential, stubBroker, tastytradeBalances } from './broker-stub'
import { migrationStore, seededItems, seedWatchlist, type SqliteD1Store } from './sqlite-d1'

const tastytrade = stubBroker()
let store: SqliteD1Store

beforeEach(async () => {
  setBrokerApi(tastytrade)
  tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
  tastytrade.tastyRequest.mockReset().mockImplementation((_env, path: string) => Promise.resolve(
    path.endsWith('/balances')
      ? { data: tastytradeBalances }
      : { data: { items: [] } },
  ))
  store = await migrationStore()
  seedWatchlist(store, seededItems(['NVDA', 'SPY']), [
    {
      kind: 'private',
      name: 'Long vol',
      metadata: { name: 'Long vol', 'group-name': 'recommendations' },
      entries: [
        { symbol: 'SPY', metadata: { symbol: 'SPY', 'instrument-type': 'Equity', note: 'hedge' } },
        { symbol: 'NVDA' },
      ],
    },
    {
      kind: 'public',
      name: 'Public research',
      entries: [{ symbol: 'NVDA', metadata: { symbol: 'NVDA', 'instrument-type': 'Equity', rank: 2 } }],
    },
  ])
  tastytrade.tastyRequest.mockClear()
})

afterEach(() => {
  resetBrokerApi()
  store.close()
})

describe('watchlist context boundary', () => {
  it('does not fetch or serialize watchlists during the default brokerage load', async () => {
    const account = await loadBrokerageContext({}, brokerCredential)
    const paths = tastytrade.tastyRequest.mock.calls.map(([, path]) => path)

    expect(paths).not.toContain('/watchlists')
    expect(account).not.toHaveProperty('watchlists')
    expect(JSON.stringify(account)).not.toContain('watchlist')
  })

  it('reads the consolidated Heston list without touching tastytrade watchlist endpoints', async () => {
    const result = await createWatchlistReadTool({ DB: store.database }).execute({})

    // Symbols only. The index answers "what is loaded" across up to 500 names; provenance and
    // instrument type are what the per-symbol mode returns, and shipping them here cost far
    // more than it told anyone.
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      mode: 'index',
      source: 'heston',
      status: 'ok',
      symbols: ['NVDA', 'SPY'],
    })
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('returns retained raw seed provenance for one exact symbol only', async () => {
    const result = await createWatchlistReadTool({ DB: store.database }).execute({ symbol: 'NVDA' })

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      mode: 'detail',
      source: 'heston',
      status: 'ok',
      details: {
        symbol: 'NVDA',
        seedMemberships: [
          { sourceKind: 'private', sourceName: 'Long vol' },
          { sourceKind: 'public', sourceName: 'Public research', entryMetadata: { rank: 2 } },
        ],
      },
    })
    expect(result.content[0]!.text).not.toContain('SPY')
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('reports an exact symbol miss without consulting the broker', async () => {
    const result = await createWatchlistReadTool({ DB: store.database }).execute({ symbol: 'META' })

    expect(JSON.parse(result.content[0]!.text)).toEqual(expect.objectContaining({
      mode: 'detail', source: 'heston', status: 'not_found', symbol: 'META',
    }))
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })
})
