import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildAgentRuntimeContext, loadBrokerageContext } from '../src/server/brokerage-context'
import { ensureInternalWatchlistSeeded, finalizeInternalWatchlist } from '../src/server/internal-watchlist'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { createWatchlistReadTool } from '../src/server/watchlist-tool'
import { stubBroker } from './broker-stub'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const tastytrade = stubBroker()
let store: SqliteD1Store

beforeEach(async () => {
  setBrokerApi(tastytrade)
  tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
  tastytrade.tastyRequest.mockReset().mockImplementation((_env, path: string) => Promise.resolve(
    path.endsWith('/balances')
      ? { data: {
          'available-trading-funds': '64000',
          'cash-available-to-withdraw': '65000',
          'cash-balance': '65000',
          'day-trading-buying-power': '256000',
          'derivative-buying-power': '64000',
          'equity-buying-power': '128000',
          'net-liquidating-value': '100000',
        } }
      : { data: { items: [] } },
  ))
  store = await migrationStore()
  const env = { DB: store.database }
  await ensureInternalWatchlistSeeded(env, async () => ({
    privatePayload: { data: { items: [{
      name: 'Long vol', 'group-name': 'recommendations',
      'watchlist-entries': [
        { symbol: 'SPY', 'instrument-type': 'Equity', note: 'hedge' },
        { symbol: 'NVDA', 'instrument-type': 'Equity' },
      ],
    }] } },
    publicPayload: { data: { items: [{
      name: 'Public research',
      'watchlist-entries': [{ symbol: 'NVDA', 'instrument-type': 'Equity', rank: 2 }],
    }] } },
  }))
  await finalizeInternalWatchlist(env, [])
  tastytrade.tastyRequest.mockClear()
})

afterEach(() => {
  resetBrokerApi()
  store.close()
})

describe('watchlist context boundary', () => {
  it('does not fetch or serialize watchlists during the default brokerage load', async () => {
    const account = await loadBrokerageContext({})
    const paths = tastytrade.tastyRequest.mock.calls.map(([, path]) => path)
    const runtimeContext = buildAgentRuntimeContext(account)

    expect(paths).not.toContain('/watchlists')
    expect(runtimeContext).not.toHaveProperty('watchlists')
    expect(JSON.stringify(runtimeContext)).not.toContain('watchlist')
  })

  it('reads the consolidated Spice list without touching tastytrade watchlist endpoints', async () => {
    const result = await createWatchlistReadTool({ DB: store.database }).execute('tool-1', {})

    expect(result.details).toMatchObject({
      mode: 'index',
      source: 'spice',
      status: 'ok',
      items: [{ symbol: 'NVDA' }, { symbol: 'SPY' }],
    })
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('returns retained raw seed provenance for one exact symbol only', async () => {
    const result = await createWatchlistReadTool({ DB: store.database }).execute('tool-2', { symbol: 'NVDA' })

    expect(result.details).toMatchObject({
      mode: 'detail',
      source: 'spice',
      status: 'ok',
      details: {
        symbol: 'NVDA',
        seedMemberships: [
          { sourceKind: 'private', sourceName: 'Long vol' },
          { sourceKind: 'public', sourceName: 'Public research', entryMetadata: { rank: 2 } },
        ],
      },
    })
    expect(JSON.stringify(result.details)).not.toContain('SPY')
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('reports an exact symbol miss without consulting the broker', async () => {
    const result = await createWatchlistReadTool({ DB: store.database }).execute('tool-3', { symbol: 'META' })

    expect(result.details).toEqual(expect.objectContaining({
      mode: 'detail', source: 'spice', status: 'not_found', symbol: 'META',
    }))
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })
})
