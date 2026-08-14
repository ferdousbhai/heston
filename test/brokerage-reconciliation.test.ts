import { describe, expect, it } from 'vitest'

import { buildOrderPayload } from '../src/server/brokerage'
import { matchesSubmittedOrder } from '../src/server/brokerage-reconciliation'

describe('brokerage submission reconciliation', () => {
  const intended = buildOrderPayload({
    action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
    optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
  }, ['SPY   260918C00600000'])

  it('requires an exact payload fingerprint inside the submission window', () => {
    const row = {
      id: '42', legs: intended.legs, 'order-type': 'Limit', price: '2.50',
      'price-effect': 'Debit', 'received-at': '2026-08-14T14:00:30.000Z', status: 'Live',
      'time-in-force': 'Day', 'updated-at': '2026-08-14T14:00:31.000Z',
    }
    expect(matchesSubmittedOrder(
      row, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(true)
    expect(matchesSubmittedOrder(
      { ...row, price: '2.55' }, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(false)
    expect(matchesSubmittedOrder(
      { ...row, 'received-at': '2026-08-13T14:00:00.000Z' }, intended,
      new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(false)

    const replacementRow = { ...row, 'replaces-order-id': '123' }
    expect(matchesSubmittedOrder(
      replacementRow, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'), '123',
    )).toBe(true)
    expect(matchesSubmittedOrder(
      replacementRow, intended, new Date('2026-08-14T14:00:00.000Z'), new Date('2026-08-14T14:01:00.000Z'), 'other',
    )).toBe(false)
  })
})
