import { beforeEach, describe, expect, it, vi } from 'vitest'

const tastytrade = vi.hoisted(() => ({ tastyRequest: vi.fn() }))
vi.mock('../src/server/tastytrade', () => tastytrade)

import { executeWatchlistAction, mutableWatchlistsFromPayload } from '../src/server/watchlist-actions'

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
  beforeEach(() => tastytrade.tastyRequest.mockReset())

  it('fails closed without issuing a write when the broker list is malformed', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{ name: 'Broken' }] } })

    await expect(executeWatchlistAction({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Broken', symbols: ['NVDA'],
    })).rejects.toThrow('invalid-response')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects incomplete pagination before rewriting any list', () => {
    expect(() => mutableWatchlistsFromPayload({
      data: { items: [] }, pagination: { 'total-items': 1 },
    })).toThrow('incomplete-response')
  })

  it('creates a missing private watchlist when adding equities', async () => {
    tastytrade.tastyRequest
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: {} })

    await executeWatchlistAction({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Catalysts', symbols: ['NVDA', 'AAPL'],
    })

    expect(tastytrade.tastyRequest).toHaveBeenNthCalledWith(2, {}, '/watchlists', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toEqual([
      { symbol: 'NVDA', 'instrument-type': 'Equity' },
      { symbol: 'AAPL', 'instrument-type': 'Equity' },
    ])
  })

  it('adds and removes exact Equity entries while preserving other instrument types', async () => {
    tastytrade.tastyRequest.mockResolvedValue(existing)
    await executeWatchlistAction({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY', 'NVDA'],
    })
    let body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toEqual([
      { symbol: 'SPY', 'instrument-type': 'Equity' },
      { symbol: 'SPY  260918C00700000', 'instrument-type': 'Equity Option' },
      { symbol: 'NVDA', 'instrument-type': 'Equity' },
    ])

    tastytrade.tastyRequest.mockReset().mockResolvedValue(existing)
    await executeWatchlistAction({}, {
      kind: 'remove_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY'],
    })
    body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toEqual([
      { symbol: 'SPY  260918C00700000', 'instrument-type': 'Equity Option' },
    ])
  })

  it('deletes only an exact validated private watchlist', async () => {
    tastytrade.tastyRequest.mockResolvedValue(existing)
    await executeWatchlistAction({}, { kind: 'delete_watchlist', watchlistName: 'Long vol' })
    expect(tastytrade.tastyRequest).toHaveBeenNthCalledWith(2, {}, '/watchlists/Long%20vol', { method: 'DELETE' })
  })

  it('deduplicates additions and reports no-op mutations accurately', async () => {
    tastytrade.tastyRequest.mockResolvedValue(existing)
    const noOp = await executeWatchlistAction({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY', 'SPY'],
    })
    expect(noOp.detail).toBe('No watchlist changes were needed for Long vol')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)

    tastytrade.tastyRequest.mockReset()
      .mockResolvedValueOnce({ data: { items: [] } })
      .mockResolvedValueOnce({ data: {} })
    await executeWatchlistAction({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Catalysts', symbols: ['NVDA', 'NVDA'],
    })
    const body = JSON.parse(tastytrade.tastyRequest.mock.calls[1]?.[2]?.body)
    expect(body['watchlist-entries']).toEqual([{ symbol: 'NVDA', 'instrument-type': 'Equity' }])
  })
})
