import { describe, expect, it } from 'vitest'

import {
  BrokerageSubmissionUnknownError,
  rejectDryRunWarnings,
  validateOrderResponse,
  validatePlacedOrderResponse,
  validateReplacementReceipt,
} from '../src/server/brokerage'
import { BrokerRefusalError } from '../src/server/caller-visible-error'
import { buildOrderPayload, replacementOrderPayload } from '../src/server/order-payload'

function brokerRefusal(attempt: () => void): BrokerRefusalError {
  try {
    attempt()
  } catch (error) {
    if (error instanceof BrokerRefusalError) return error
    throw error
  }
  throw new Error('expected a broker refusal')
}

const intended = {
  'order-type': 'Limit' as const,
  'time-in-force': 'Day' as const,
  price: '5.05',
  'price-effect': 'Debit' as const,
  legs: [{
    action: 'Buy to Open', quantity: 1, symbol: 'SPY   260918C00700000',
    'instrument-type': 'Equity Option' as const,
  }],
}
const brokerOrder = {
  'order-type': 'Limit', 'time-in-force': 'Day', price: '5.05', 'price-effect': 'Debit', id: 123,
  legs: intended.legs,
}

describe('broker order response boundary', () => {
  it('forces closing orders to fail instead of opening a new position after a broker-side race', () => {
    const closePayload = buildOrderPayload({
      action: 'Sell to Close',
      kind: 'place_equity_order',
      limitPrice: 700,
      priceEffect: 'Credit',
      quantity: 1,
      symbol: 'SPY',
    }, ['SPY'])
    expect(closePayload['advanced-instructions']).toEqual({
      'strict-position-effect-validation': true,
    })

    const openPayload = buildOrderPayload({
      action: 'Buy to Open',
      expiry: '2026-09-18',
      kind: 'place_option_order',
      limitPrice: 5.05,
      optionType: 'C',
      priceEffect: 'Debit',
      quantity: 1,
      strike: 700,
      underlying: 'SPY',
    }, ['SPY   260918C00700000'])
    expect(openPayload).not.toHaveProperty('advanced-instructions')
  })

  it('builds a two-leg debit vertical and requires an exact replacement receipt', () => {
    const spread = buildOrderPayload({
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C',
      expiry: '2026-09-18', longStrike: 700, shortStrike: 710,
      quantity: 2, limitPrice: 3.5, priceEffect: 'Debit',
    }, ['SPY   260918C00700000', 'SPY   260918C00710000'])
    expect(spread.legs.map((leg) => leg.action)).toEqual(['Buy to Open', 'Sell to Open'])
    expect(spread.price).toBe('3.50')
    expect(replacementOrderPayload(spread)).not.toHaveProperty('legs')

    expect(validateReplacementReceipt({ data: {
      id: '456', 'replaces-order-id': '123', ...spread,
    } }, '123', spread)).toEqual({ id: '456' })
    expect(() => validateReplacementReceipt({ data: {
      id: '456', 'replaces-order-id': 'other', ...spread,
    } }, '123', spread)).toThrow(BrokerageSubmissionUnknownError)
  })

  it('requires dry-run order, buying-power effect, and an exact echoed intent', () => {
    expect(validateOrderResponse({ data: {
      order: brokerOrder,
      'buying-power-effect': { effect: 'Debit', 'change-in-buying-power': '-505' },
      warnings: [{ code: 'review', message: 'Review this order' }],
    } }, intended)).toEqual({ id: '123', warnings: ['Review this order'] })

    expect(() => validateOrderResponse({ data: { order: brokerOrder } }, intended)).toThrow('missing-order-or-buying-power')
    expect(() => validateOrderResponse({ data: {
      order: { ...brokerOrder, price: '6.00' }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended)).toThrow('echo-mismatch')
  })

  it('accepts a risk-reducing close whose buying-power effect is the opposite of its price effect', () => {
    // Buying back a short option is a debit that frees margin: the broker reports its
    // buying-power effect as a Credit. That is a different fact from the price effect, and it
    // must not read as an echo mismatch.
    const buyToClose = buildOrderPayload({
      action: 'Buy to Close', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 1.2,
      optionType: 'P', priceEffect: 'Debit', quantity: 1, strike: 600, underlying: 'SPY',
    }, ['SPY   260918P00600000'])
    const echoed = {
      id: 789, legs: buyToClose.legs, 'order-type': 'Limit', price: '1.20', 'price-effect': 'Debit', 'time-in-force': 'Day',
    }
    expect(validateOrderResponse({ data: {
      order: echoed, 'buying-power-effect': { effect: 'Credit', 'change-in-buying-power': '880' },
    } }, buyToClose)).toEqual({ id: '789', warnings: [] })
    // The order's own price effect is still compared.
    expect(() => validateOrderResponse({ data: {
      order: { ...echoed, 'price-effect': 'Credit' }, 'buying-power-effect': { effect: 'Credit' },
    } }, buyToClose)).toThrow('echo-mismatch')
  })

  it('fails closed on a dry-run warning before placement', () => {
    const warned = brokerRefusal(() => rejectDryRunWarnings(['Review position effect']))
    expect(warned).toMatchObject({ check: 'broker-warning', untrustedBrokerData: { messages: ['Review position effect'] } })
    expect(warned.message).toBe('Tastytrade returned a preflight warning, so the order was not submitted.')
    expect(() => rejectDryRunWarnings([])).not.toThrow()
  })

  it('rejects broker errors and quarantines a placed response without an order id', () => {
    const rejected = brokerRefusal(() => validateOrderResponse({ data: {
      errors: [{ code: 'invalid-price', message: 'Off tick' }],
    } }, intended))
    expect(rejected).toMatchObject({ check: 'broker-rejected', untrustedBrokerData: { messages: ['Off tick'] } })
    expect(rejected.message).not.toContain('Off tick')

    expect(validateOrderResponse({ data: {
      order: { ...brokerOrder, id: undefined }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended).id).toBeUndefined()
    expect(() => validatePlacedOrderResponse({ data: {
      order: { ...brokerOrder, id: undefined }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended)).toThrow(BrokerageSubmissionUnknownError)
  })

  it('quarantines every unverified 2xx placement response but preserves a proven rejection', () => {
    const ambiguous = [
      { data: { order: brokerOrder } },
      { data: { order: { ...brokerOrder, price: '6.00' }, 'buying-power-effect': { effect: 'Debit' } } },
      { data: { order: brokerOrder, 'buying-power-effect': { effect: 'Debit' }, warnings: ['malformed'] } },
      { data: { order: { ...brokerOrder, id: undefined }, 'buying-power-effect': { effect: 'Debit' } } },
      { data: { errors: [{}] } },
      { data: { errors: [{ message: { nested: 'not a message' } }] } },
    ]
    for (const payload of ambiguous) {
      expect(() => validatePlacedOrderResponse(payload, intended)).toThrow(BrokerageSubmissionUnknownError)
    }
    expect(brokerRefusal(() => validatePlacedOrderResponse({ data: {
      errors: [{ code: 'invalid-price', message: 'Off tick' }],
    } }, intended))).toMatchObject({ check: 'broker-rejected', untrustedBrokerData: { messages: ['Off tick'] } })
  })

  it('reads a 2xx whose exact echo says Rejected as a refusal, not an accepted order', () => {
    expect(brokerRefusal(() => validatePlacedOrderResponse({ data: {
      order: { ...brokerOrder, status: 'Rejected' }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended))).toMatchObject({ check: 'broker-rejected' })
    expect(validatePlacedOrderResponse({ data: {
      order: { ...brokerOrder, status: 'Received' }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended)).toEqual({ id: '123', warnings: [] })

    const replaced = { ...brokerOrder, id: '456', 'replaces-order-id': '123' }
    expect(brokerRefusal(() => validateReplacementReceipt({ data: { ...replaced, status: 'Rejected' } }, '123', intended)))
      .toMatchObject({ check: 'broker-rejected' })
    expect(validateReplacementReceipt({ data: { ...replaced, status: 'Live' } }, '123', intended)).toEqual({ id: '456' })
  })
})
