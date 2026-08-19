import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { buildAgentRuntimeContext, loadBrokerageContext } from '../src/server/brokerage-context'
import {
  createWatchlistReadTool,
  watchlistsFromPayload,
} from '../src/server/watchlist-tool'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

const watchlistPayload = {
  data: {
    items: [
      {
        name: 'Long vol',
        'watchlist-entries': [
          { symbol: 'SPY', 'instrument-type': 'Equity' },
          { symbol: 'NVDA', 'instrument-type': 'Equity' },
        ],
      },
      {
        name: 'Research',
        'watchlist-entries': [{ symbol: 'AAPL', 'instrument-type': 'Equity' }],
      },
    ],
  },
}

describe('watchlist context boundary', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
    tastytrade.tastyRequest.mockReset().mockResolvedValue({ data: { items: [] } })
  })

  it('does not fetch or serialize watchlists during the default brokerage load', async () => {
    const account = await loadBrokerageContext({})
    const paths = tastytrade.tastyRequest.mock.calls.map(([, path]) => path)
    const runtimeContext = buildAgentRuntimeContext(account, [])

    expect(paths).not.toContain('/watchlists')
    expect(runtimeContext).not.toHaveProperty('watchlists')
    expect(JSON.stringify(runtimeContext)).not.toContain('watchlist')
  })

  it('lists private watchlist names without exposing their symbols', async () => {
    tastytrade.tastyRequest.mockResolvedValue(watchlistPayload)
    const tool = createWatchlistReadTool({})
    const result = await tool.execute('tool-1', {})
    const output = result.content.find((part) => part.type === 'text')?.text ?? ''

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/watchlists')
    expect(result.details).toMatchObject({
      mode: 'index',
      source: 'tastytrade',
      status: 'ok',
      watchlistType: 'private',
      watchlists: [
        { entryCount: 2, name: 'Long vol' },
        { entryCount: 1, name: 'Research' },
      ],
    })
    expect(output).not.toContain('SPY')
    expect(output).not.toContain('NVDA')
    expect(output).not.toContain('AAPL')
  })

  it('returns symbols for one exact requested watchlist only', async () => {
    tastytrade.tastyRequest.mockResolvedValue(watchlistPayload)
    const result = await createWatchlistReadTool({}).execute('tool-2', { watchlistName: 'Long vol' })

    expect(result.details).toMatchObject({
      entries: [
        { instrumentType: 'Equity', symbol: 'SPY' },
        { instrumentType: 'Equity', symbol: 'NVDA' },
      ],
      mode: 'detail',
      source: 'tastytrade',
      status: 'ok',
      watchlistType: 'private',
      watchlistName: 'Long vol',
    })
    expect(JSON.stringify(result.details)).not.toContain('AAPL')
  })

  it('fails closed on malformed broker data and reports an exact-name miss', async () => {
    expect(() => watchlistsFromPayload({ data: { items: [{ name: 'Broken' }] } })).toThrow('invalid-response')

    tastytrade.tastyRequest.mockResolvedValue(watchlistPayload)
    const result = await createWatchlistReadTool({}).execute('tool-3', { watchlistName: 'Missing' })
    expect(result.details).toMatchObject({
      mode: 'detail', source: 'tastytrade', status: 'not_found', watchlistName: 'Missing',
      watchlistType: 'private',
    })
  })

  it('reads public watchlists only when explicitly requested', async () => {
    tastytrade.tastyRequest.mockResolvedValue(watchlistPayload)
    const result = await createWatchlistReadTool({}).execute('tool-public', { watchlistType: 'public' })

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/public-watchlists')
    expect(result.details).toMatchObject({ mode: 'index', watchlistType: 'public' })
  })
})
