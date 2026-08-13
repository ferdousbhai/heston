import { describe, expect, it } from 'vitest'

import {
  BrokerageSubmissionUnknownError,
  buildOrderPayload,
  rejectDryRunWarnings,
  validateOrderResponse,
  validatePlacedOrderResponse,
} from '../src/server/brokerage'

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
  'order-type': 'Limit', 'time-in-force': 'Day', price: '5.05', id: 123,
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
    }, 'SPY')
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
    }, 'SPY   260918C00700000')
    expect(openPayload).not.toHaveProperty('advanced-instructions')
  })

  it('requires dry-run order, buying-power effect, and an exact echoed intent', () => {
    expect(validateOrderResponse({ data: {
      order: brokerOrder,
      'buying-power-effect': { effect: 'Debit', 'change-in-buying-power': '-505' },
      warnings: [{ code: 'review', message: 'Review this order' }],
    } }, intended, false)).toEqual({ id: '123', warnings: ['Review this order'] })

    expect(() => validateOrderResponse({ data: { order: brokerOrder } }, intended, false)).toThrow('missing-order-or-buying-power')
    expect(() => validateOrderResponse({ data: {
      order: { ...brokerOrder, price: '6.00' }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended, false)).toThrow('echo-mismatch')
  })

  it('fails closed on a dry-run warning before placement', () => {
    expect(() => rejectDryRunWarnings(['Review position effect'])).toThrow(
      'Tastytrade returned a preflight warning, so the order was not submitted: Review position effect',
    )
    expect(() => rejectDryRunWarnings([])).not.toThrow()
  })

  it('rejects broker errors and quarantines a placed response without an order id', () => {
    expect(() => validateOrderResponse({ data: {
      errors: [{ code: 'invalid-price', message: 'Off tick' }],
    } }, intended, false)).toThrow('TastytradeOrderRejected:Off tick')

    expect(() => validateOrderResponse({ data: {
      order: { ...brokerOrder, id: undefined }, 'buying-power-effect': { effect: 'Debit' },
    } }, intended, true)).toThrow(BrokerageSubmissionUnknownError)
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
    expect(() => validatePlacedOrderResponse({ data: {
      errors: [{ code: 'invalid-price', message: 'Off tick' }],
    } }, intended)).toThrow('TastytradeOrderRejected:Off tick')
  })
})
