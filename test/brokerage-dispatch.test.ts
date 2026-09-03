import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executeOrderPlacement } from '../src/server/brokerage'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetTradeGuards, setTradeGuards, type TradeGuards } from '../src/server/trade-guards'
import { brokerCredential, stubBroker } from './broker-stub'

const guards = {
  assertOrderMarketSafe: vi.fn(),
  assertPortfolioActionAllowed: vi.fn(),
} satisfies TradeGuards

const broker = stubBroker()

const mocks = { ...broker, ...guards }

beforeEach(() => {
  setBrokerApi(broker)
  setTradeGuards(guards)
})

afterEach(() => {
  resetBrokerApi()
  resetTradeGuards()
})

const action = {
  action: 'Buy to Open' as const,
  kind: 'place_equity_order' as const,
  limitPrice: 700,
  priceEffect: 'Debit' as const,
  quantity: 1,
  symbol: 'SPY',
}

function response(warnings: Array<{ message: string }> = [], id = 123) {
  return { data: {
    'buying-power-effect': { effect: 'Debit' },
    order: {
      id,
      legs: [{
        action: 'Buy to Open',
        'instrument-type': 'Equity',
        quantity: 1,
        symbol: 'SPY',
      }],
      'order-type': 'Limit',
      price: '700.00',
      'time-in-force': 'Day',
    },
    warnings,
  } }
}

describe('brokerage dispatch warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.resolveAccountNumber.mockResolvedValue('TEST123')
    mocks.assertPortfolioActionAllowed.mockResolvedValue({ allowed: true })
    mocks.assertOrderMarketSafe.mockResolvedValue({})
  })

  it('does not place an order after a dry-run warning', async () => {
    mocks.tastyRequest.mockResolvedValue(response([{ message: 'Review position effect' }]))

    await expect(executeOrderPlacement({}, action, brokerCredential)).rejects.toThrow('order was not submitted')
    expect(mocks.tastyRequest).toHaveBeenCalledTimes(1)
    expect(mocks.tastyRequest.mock.calls[0]?.[1]).toContain('/orders/dry-run')
    expect(mocks.withBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(mocks.renewBrokerMutationLease).toHaveBeenCalledTimes(1)
  })

  it('retains warnings returned with an already-accepted order', async () => {
    mocks.tastyRequest
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([{ message: 'Order queued for review' }]))

    await expect(executeOrderPlacement({}, action, brokerCredential)).resolves.toEqual({
      detail: 'Order #123 accepted by tastytrade. Broker warning: Order queued for review',
      orderId: '123',
    })
    expect(mocks.withBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(mocks.renewBrokerMutationLease).toHaveBeenCalledTimes(2)
  })
})
