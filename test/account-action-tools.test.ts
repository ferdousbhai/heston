import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import {
  resetWatchlistWriter,
  setWatchlistWriter,
  type WatchlistWriter,
} from '../src/server/watchlist-actions'
import { stubBroker } from './broker-stub'
import {
  createCancelOrderTool,
  createRememberTradeSymbolsTool,
  createWatchlistManagementTool,
} from '../src/server/account-action-tools'
import { preparePendingAction, rememberTradeIntentSymbol } from '../src/server/agent'
import {
  resetInternalWatchlistWriter,
  setInternalWatchlistWriter,
  type InternalWatchlistWriter,
} from '../src/server/internal-watchlist'

const tastytrade = stubBroker()
const watchlists = { executeWatchlistAction: vi.fn() } satisfies WatchlistWriter
const internalWatchlist = { ensureSymbols: vi.fn() } satisfies InternalWatchlistWriter

beforeEach(() => {
  setBrokerApi(tastytrade)
  setWatchlistWriter(watchlists)
  setInternalWatchlistWriter(internalWatchlist)
})

afterEach(() => {
  resetBrokerApi()
  resetWatchlistWriter()
  resetInternalWatchlistWriter()
})

describe('direct non-placement actions', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
    tastytrade.tastyRequest.mockReset().mockResolvedValue({})
    tastytrade.withBrokerMutationLease.mockClear()
    tastytrade.renewBrokerMutationLease.mockClear()
    watchlists.executeWatchlistAction.mockReset().mockResolvedValue({ detail: 'updated' })
    internalWatchlist.ensureSymbols.mockReset().mockResolvedValue([])
  })

  it('cancels an explicitly identified order without creating a confirmation draft', async () => {
    const result = await createCancelOrderTool({}, 'Please cancel order #12345.').execute('call-1', { orderId: '12345' })

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {}, '/accounts/TEST123/orders/12345', { method: 'DELETE' },
    )
    expect(tastytrade.withBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(tastytrade.renewBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(result.details).toEqual({ orderId: '12345', status: 'cancelled' })
  })

  it('updates watchlists directly while retaining the strict server action schema', async () => {
    const result = await createWatchlistManagementTool({}, 'Add SPY and NVDA to my watchlist.').execute('call-2', {
      action: 'add', symbols: ['SPY', 'NVDA'],
    })

    expect(watchlists.executeWatchlistAction).toHaveBeenCalledWith({}, {
      kind: 'add_watchlist_symbols', symbols: ['SPY', 'NVDA'],
    })
    expect(result.details).toEqual({ detail: 'updated' })
  })

  it('never automatically repeats a failed direct mutation in one model turn', async () => {
    tastytrade.tastyRequest.mockRejectedValueOnce(new Error('Upstream response lost'))
    watchlists.executeWatchlistAction.mockRejectedValueOnce(new Error('Upstream response lost'))
    const cancelTool = createCancelOrderTool({}, 'Cancel order #12345.')
    const watchlistTool = createWatchlistManagementTool({}, 'Add SPY to my watchlist.')

    await expect(cancelTool.execute('cancel-1', { orderId: '12345' })).rejects.toThrow('Upstream response lost')
    await expect(cancelTool.execute('cancel-2', { orderId: '12345' })).rejects.toThrow('DirectActionAlreadyAttempted')
    await expect(watchlistTool.execute('watchlist-1', {
      action: 'add', symbols: ['SPY'],
    })).rejects.toThrow('Upstream response lost')
    await expect(watchlistTool.execute('watchlist-2', {
      action: 'add', symbols: ['SPY'],
    })).rejects.toThrow('DirectActionAlreadyAttempted')

    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
    expect(watchlists.executeWatchlistAction).toHaveBeenCalledTimes(1)
  })

  it('rejects model-selected cancellation parameters that do not exactly match the current request', async () => {
    await expect(createCancelOrderTool({}, 'Cancel order #999.').execute('call-3', { orderId: '12345' }))
      .rejects.toThrow('DirectActionIntentMismatch')
    await expect(createCancelOrderTool({}, 'Explain how cancelling order #12345 works.').execute('call-4', { orderId: '12345' }))
      .rejects.toThrow('DirectActionIntentMismatch')

    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('rejects mismatched watchlist verbs, named broker lists, and symbol sets before any write', async () => {
    const cases = [
      ['Remove SPY from my watchlist.', { action: 'add' as const, symbols: ['SPY'] }],
      ['Add SPY to Long vol watchlist.', { action: 'add' as const, symbols: ['SPY'] }],
      ['Add SPY to my watchlist.', { action: 'add' as const, symbols: ['SPY', 'NVDA'] }],
    ] as const
    for (const [message, params] of cases) {
      const mutableParams = 'symbols' in params ? { ...params, symbols: [...params.symbols] } : params
      await expect(createWatchlistManagementTool({}, message).execute('call-5', mutableParams))
        .rejects.toThrow('DirectActionIntentMismatch')
    }

    expect(watchlists.executeWatchlistAction).not.toHaveBeenCalled()
  })

  it('can idempotently remember a substantively discussed trade symbol', async () => {
    internalWatchlist.ensureSymbols.mockResolvedValueOnce(['PLTR'])

    const result = await createRememberTradeSymbolsTool({}).execute('remember-1', { symbols: ['PLTR'] })

    expect(internalWatchlist.ensureSymbols).toHaveBeenCalledWith({}, ['PLTR'], 'agent-discussion')
    expect(result.details).toEqual({ remembered: ['PLTR'] })
  })

  it('deterministically remembers the exact underlying of a resolved trade intent', async () => {
    await rememberTradeIntentSymbol({}, {
      kind: 'place_option_order', underlying: 'META', optionType: 'C', strike: 900,
      expiry: '2026-10-16', action: 'Buy to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Debit',
    })

    expect(internalWatchlist.ensureSymbols).toHaveBeenCalledWith({}, ['META'], 'trade-intent')
  })

  it('refuses to put non-placement actions into the confirmation store', async () => {
    await expect(preparePendingAction({}, {
      kind: 'add_watchlist_symbols', symbols: ['SPY'],
    })).rejects.toThrow()
    expect(watchlists.executeWatchlistAction).not.toHaveBeenCalled()
  })
})
