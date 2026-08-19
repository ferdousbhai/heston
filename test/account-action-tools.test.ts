import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import {
  resetWatchlistWriter,
  setWatchlistWriter,
  type WatchlistWriter,
} from '../src/server/watchlist-actions'
import { stubBroker } from './broker-stub'
import { createCancelOrderTool, createWatchlistManagementTool } from '../src/server/account-action-tools'
import { preparePendingAction } from '../src/server/agent'

const tastytrade = stubBroker()
const watchlists = { executeWatchlistAction: vi.fn() } satisfies WatchlistWriter

beforeEach(() => {
  setBrokerApi(tastytrade)
  setWatchlistWriter(watchlists)
})

afterEach(() => {
  resetBrokerApi()
  resetWatchlistWriter()
})

describe('direct non-placement actions', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
    tastytrade.tastyRequest.mockReset().mockResolvedValue({})
    watchlists.executeWatchlistAction.mockReset().mockResolvedValue({ detail: 'updated' })
  })

  it('cancels an explicitly identified order without creating a confirmation draft', async () => {
    const result = await createCancelOrderTool({}, 'Please cancel order #12345.').execute('call-1', { orderId: '12345' })

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {}, '/accounts/TEST123/orders/12345', { method: 'DELETE' },
    )
    expect(result.details).toEqual({ orderId: '12345', status: 'cancelled' })
  })

  it('updates watchlists directly while retaining the strict server action schema', async () => {
    const result = await createWatchlistManagementTool({}, 'Add SPY and NVDA to my Long vol watchlist.').execute('call-2', {
      action: 'add', watchlistName: 'Long vol', symbols: ['SPY', 'NVDA'],
    })

    expect(watchlists.executeWatchlistAction).toHaveBeenCalledWith({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY', 'NVDA'],
    })
    expect(result.details).toEqual({ detail: 'updated' })
  })

  it('rejects model-selected cancellation parameters that do not exactly match the current request', async () => {
    await expect(createCancelOrderTool({}, 'Cancel order #999.').execute('call-3', { orderId: '12345' }))
      .rejects.toThrow('DirectActionIntentMismatch')
    await expect(createCancelOrderTool({}, 'Explain how cancelling order #12345 works.').execute('call-4', { orderId: '12345' }))
      .rejects.toThrow('DirectActionIntentMismatch')

    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('rejects mismatched watchlist verbs, names, and symbol sets before any write', async () => {
    const cases = [
      ['Remove SPY from Long vol watchlist.', { action: 'add' as const, watchlistName: 'Long vol', symbols: ['SPY'] }],
      ['Add SPY to Long vol watchlist.', { action: 'add' as const, watchlistName: 'Other', symbols: ['SPY'] }],
      ['Add SPY to Long vol watchlist.', { action: 'add' as const, watchlistName: 'Long vol', symbols: ['SPY', 'NVDA'] }],
    ] as const
    for (const [message, params] of cases) {
      const mutableParams = 'symbols' in params ? { ...params, symbols: [...params.symbols] } : params
      await expect(createWatchlistManagementTool({}, message).execute('call-5', mutableParams))
        .rejects.toThrow('DirectActionIntentMismatch')
    }

    expect(watchlists.executeWatchlistAction).not.toHaveBeenCalled()
  })

  it('refuses to put non-placement actions into the confirmation store', async () => {
    await expect(preparePendingAction({}, {
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['SPY'],
    })).rejects.toThrow()
    expect(watchlists.executeWatchlistAction).not.toHaveBeenCalled()
  })
})
