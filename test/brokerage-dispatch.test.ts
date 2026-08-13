import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executeOrderPlacement } from '../src/server/brokerage'

const mocks = vi.hoisted(() => ({
  assertOrderMarketSafe: vi.fn(),
  assertPortfolioActionAllowed: vi.fn(),
  resolveAccountNumber: vi.fn(),
  tastyRequest: vi.fn(),
}))

vi.mock('../src/server/order-market', () => ({ assertOrderMarketSafe: mocks.assertOrderMarketSafe }))
vi.mock('../src/server/portfolio-risk', () => ({ assertPortfolioActionAllowed: mocks.assertPortfolioActionAllowed }))
vi.mock('../src/server/tastytrade', () => ({
  resolveAccountNumber: mocks.resolveAccountNumber,
  tastyRequest: mocks.tastyRequest,
}))

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

    await expect(executeOrderPlacement({}, action)).rejects.toThrow('order was not submitted')
    expect(mocks.tastyRequest).toHaveBeenCalledTimes(1)
    expect(mocks.tastyRequest.mock.calls[0]?.[1]).toContain('/orders/dry-run')
  })

  it('retains warnings returned with an already-accepted order', async () => {
    mocks.tastyRequest
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([{ message: 'Order queued for review' }]))

    await expect(executeOrderPlacement({}, action)).resolves.toEqual({
      detail: 'Order #123 accepted by tastytrade. Broker warning: Order queued for review',
      orderId: '123',
    })
  })
})
