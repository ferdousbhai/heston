import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type AppEnv } from '../src/server/env'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import {
  executeAggregateWatchlistAction,
  executeWatchlistAction,
  mutableWatchlistsFromPayload,
} from '../src/server/watchlist-actions'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

const existing = {
  data: {
    items: [{
      name: 'Long vol',
      'group-name': 'main',
      'order-index': 2,
      'watchlist-entries': [
        { symbol: 'SPY', 'instrument-type': 'Equity' },
        { symbol: 'SPY  260918C00700000', 'instrument-type': 'Equity Option' },
      ],
    }],
  },
}

describe('watchlist mutation boundary', () => {
  let env: AppEnv

  beforeEach(() => {
    tastytrade.tastyRequest.mockReset()
    env = {
      BROKER_GATE: {
        getByName: () => ({
          acquire: async () => undefined,
          acquireMutation: async () => 'test-lease',
          releaseMutation: async () => undefined,
        }),
      },
    }
  })

  it('fails closed without issuing a write when the broker list is malformed', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{ name: 'Broken' }] } })

    await expect(executeWatchlistAction(env, {
      kind: 'add_watchlist_symbols', watchlistName: 'Broken', symbols: ['NVDA'],
    })).rejects.toThrow('invalid-response')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects incomplete pagination before rewriting any list', () => {
    expect(() => mutableWatchlistsFromPayload({
      data: { items: [] }, pagination: { 'total-items': 1 },
    })).toThrow('incomplete-response')
  })

  it('does not create a missing private watchlist when adding equities', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [] } })

    await expect(executeWatchlistAction(env, {
      kind: 'add_watchlist_symbols', watchlistName: 'Catalysts', symbols: ['NVDA', 'AAPL'],
    })).rejects.toThrow('not-found')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
  })

  it('adds and removes exact Equity entries while preserving other instrument types', async () => {
    tastytrade.tastyRequest.mockResolvedValue(existing)
    await executeWatchlistAction(env, {
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY', 'NVDA'],
    })
    let body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toEqual([
      { symbol: 'SPY', 'instrument-type': 'Equity' },
      { symbol: 'SPY  260918C00700000', 'instrument-type': 'Equity Option' },
      { symbol: 'NVDA', 'instrument-type': 'Equity' },
    ])

    tastytrade.tastyRequest.mockReset().mockResolvedValue(existing)
    await executeWatchlistAction(env, {
      kind: 'remove_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY'],
    })
    body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toEqual([
      { symbol: 'SPY  260918C00700000', 'instrument-type': 'Equity Option' },
    ])
  })

  it('deduplicates additions and reports no-op mutations accurately', async () => {
    tastytrade.tastyRequest.mockResolvedValue(existing)
    const noOp = await executeWatchlistAction(env, {
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY', 'SPY'],
    })
    expect(noOp.detail).toBe('No watchlist changes were needed for Long vol')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)

  })

  it('adds an aggregate item to an existing private list without creating a list', async () => {
    tastytrade.tastyRequest.mockResolvedValue(existing)
    await executeAggregateWatchlistAction(env, { kind: 'add_watchlist_symbols', symbols: ['NVDA'] })

    expect(tastytrade.tastyRequest).toHaveBeenNthCalledWith(2, env, '/watchlists/Long%20vol', expect.objectContaining({ method: 'PUT' }))
    const body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toContainEqual({ symbol: 'NVDA', 'instrument-type': 'Equity' })
  })

  it('removes an aggregate item from every private list that contains it', async () => {
    tastytrade.tastyRequest.mockResolvedValue({
      data: {
        items: [
          existing.data.items[0],
          { ...existing.data.items[0], name: 'Second list', 'watchlist-entries': [
            { symbol: 'SPY', 'instrument-type': 'Equity' },
            { symbol: 'NVDA', 'instrument-type': 'Equity' },
          ] },
        ],
      },
    })
    await executeAggregateWatchlistAction(env, { kind: 'remove_watchlist_symbols', symbols: ['SPY'] })

    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(3)
    for (const call of tastytrade.tastyRequest.mock.calls.slice(1)) {
      const body = JSON.parse(call[2]?.body)
      expect(body['watchlist-entries']).not.toContainEqual({ symbol: 'SPY', 'instrument-type': 'Equity' })
    }
  })

  it('does not implicitly create a private list for the aggregate Watchlist', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [] } })
    await expect(executeAggregateWatchlistAction(env, {
      kind: 'add_watchlist_symbols', symbols: ['NVDA'],
    })).rejects.toThrow('not-found')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent read-modify-write mutations through the account gate', async () => {
    let locked = false
    let active = 0
    let maxActive = 0
    const waiters: Array<() => void> = []
    const env = {
      BROKER_GATE: {
        getByName: () => ({
          acquire: async () => undefined,
          acquireMutation: async () => {
            if (locked) await new Promise<void>((resolve) => waiters.push(resolve))
            locked = true
            active += 1
            maxActive = Math.max(maxActive, active)
            return crypto.randomUUID()
          },
          releaseMutation: async () => {
            active -= 1
            locked = false
            waiters.shift()?.()
          },
        }),
      },
    }
    tastytrade.tastyRequest.mockResolvedValue(existing)

    await Promise.all([
      executeAggregateWatchlistAction(env, { kind: 'add_watchlist_symbols', symbols: ['NVDA'] }),
      executeAggregateWatchlistAction(env, { kind: 'add_watchlist_symbols', symbols: ['AAPL'] }),
    ])

    expect(maxActive).toBe(1)
    expect(active).toBe(0)
  })
})
