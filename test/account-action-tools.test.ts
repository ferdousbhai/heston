import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import {
  resetWatchlistWriter,
  setWatchlistWriter,
  type WatchlistWriter,
} from '../src/server/watchlist-actions'
import { brokerCredential, stubBroker } from './broker-stub'
import {
  BrokerageCancellationUnknownError,
  createDirectAccountActionTool,
  createRememberTradeSymbolsTool,
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
    watchlists.executeWatchlistAction.mockReset().mockResolvedValue({
      appliedSymbols: ['SPY', 'NVDA'], detail: 'updated', discardedSymbols: [],
    })
    internalWatchlist.ensureSymbols.mockReset().mockResolvedValue([])
  })

  it('cancels an explicitly identified order without creating a confirmation draft', async () => {
    const result = await createDirectAccountActionTool({}, 'Please cancel order #12345.', brokerCredential).execute('call-1', {
      kind: 'cancel_order', orderId: '12345',
    })

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {}, '/accounts/TEST123/orders/12345', { method: 'DELETE' }, brokerCredential,
    )
    expect(tastytrade.withBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(tastytrade.renewBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(result.details).toEqual({ orderId: '12345', status: 'cancelled' })
  })

  it('updates watchlists directly while retaining the strict server action schema', async () => {
    const result = await createDirectAccountActionTool({}, 'Add SPY and NVDA to my watchlist.', undefined).execute('call-2', {
      kind: 'add_watchlist_symbols', symbols: ['SPY', 'NVDA'],
    })

    expect(watchlists.executeWatchlistAction).toHaveBeenCalledWith({}, {
      kind: 'add_watchlist_symbols', symbols: ['SPY', 'NVDA'],
    })
    expect(result.details).toEqual({
      appliedSymbols: ['SPY', 'NVDA'], detail: 'updated', discardedSymbols: [],
    })
  })

  it('never automatically repeats a failed direct mutation in one model turn', async () => {
    tastytrade.tastyRequest.mockRejectedValueOnce(new Error('Upstream response lost'))
    watchlists.executeWatchlistAction.mockRejectedValueOnce(new Error('Upstream response lost'))
    const cancelTool = createDirectAccountActionTool({}, 'Cancel order #12345.', brokerCredential)
    const watchlistTool = createDirectAccountActionTool({}, 'Add SPY to my watchlist.', undefined)

    await expect(cancelTool.execute('cancel-1', { kind: 'cancel_order', orderId: '12345' }))
      .rejects.toBeInstanceOf(BrokerageCancellationUnknownError)
    await expect(cancelTool.execute('cancel-2', { kind: 'cancel_order', orderId: '12345' })).rejects.toThrow('DirectActionAlreadyAttempted')
    await expect(watchlistTool.execute('watchlist-1', {
      kind: 'add_watchlist_symbols', symbols: ['SPY'],
    })).rejects.toThrow('Upstream response lost')
    await expect(watchlistTool.execute('watchlist-2', {
      kind: 'add_watchlist_symbols', symbols: ['SPY'],
    })).rejects.toThrow('DirectActionAlreadyAttempted')

    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
    expect(watchlists.executeWatchlistAction).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['network loss', new TypeError('fetch failed')],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['provider 5xx', Object.assign(new Error('TastytradeApi:503:/orders/12345'), { name: 'TastytradeApiAmbiguousError' })],
  ])('reports an explicit unknown cancellation after %s', async (_label, failure) => {
    tastytrade.tastyRequest.mockRejectedValueOnce(failure)
    const tool = createDirectAccountActionTool({}, 'Cancel order #12345.', brokerCredential)

    await expect(tool.execute('cancel-ambiguous', { kind: 'cancel_order', orderId: '12345' }))
      .rejects.toMatchObject({
        message: expect.stringContaining('may have received this cancellation'),
        name: 'BrokerageCancellationUnknownError',
      })
    await expect(tool.execute('cancel-retry', { kind: 'cancel_order', orderId: '12345' }))
      .rejects.toThrow('DirectActionAlreadyAttempted')
  })

  it('preserves a definitive provider rejection for a cancellation', async () => {
    const rejection = Object.assign(new Error('TastytradeApi:422:/orders/12345'), {
      name: 'TastytradeApiError',
    })
    tastytrade.tastyRequest.mockRejectedValueOnce(rejection)

    await expect(createDirectAccountActionTool({}, 'Cancel order #12345.', brokerCredential).execute(
      'cancel-rejected',
      { kind: 'cancel_order', orderId: '12345' },
    )).rejects.toBe(rejection)
  })

  it('rejects model-selected cancellation parameters that do not exactly match the current request', async () => {
    await expect(createDirectAccountActionTool({}, 'Cancel order #999.', brokerCredential).execute('call-3', {
      kind: 'cancel_order', orderId: '12345',
    }))
      .rejects.toThrow('DirectActionIntentMismatch')
    await expect(createDirectAccountActionTool({}, 'Explain how cancelling order #12345 works.', brokerCredential).execute('call-4', {
      kind: 'cancel_order', orderId: '12345',
    }))
      .rejects.toThrow('DirectActionIntentMismatch')

    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('rejects mismatched watchlist verbs, named broker lists, and symbol sets before any write', async () => {
    const cases = [
      ['Remove SPY from my watchlist.', { kind: 'add_watchlist_symbols' as const, symbols: ['SPY'] }],
      ['Add SPY to Long vol watchlist.', { kind: 'add_watchlist_symbols' as const, symbols: ['SPY'] }],
      ['Add SPY to my watchlist.', { kind: 'add_watchlist_symbols' as const, symbols: ['SPY', 'NVDA'] }],
    ] as const
    for (const [message, params] of cases) {
      const mutableParams = 'symbols' in params ? { ...params, symbols: [...params.symbols] } : params
      await expect(createDirectAccountActionTool({}, message, undefined).execute('call-5', mutableParams))
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
    }, undefined)).rejects.toThrow()
    expect(watchlists.executeWatchlistAction).not.toHaveBeenCalled()
  })
})
