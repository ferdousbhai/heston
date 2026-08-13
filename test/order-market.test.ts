import { describe, expect, it } from 'vitest'

import { orderMarketFromPayloads } from '../src/server/order-market'

const option = {
  kind: 'place_option_order' as const,
  underlying: 'SPY', optionType: 'C' as const, strike: 700, expiry: '2026-09-18',
  action: 'Buy to Open' as const, quantity: 1, limitPrice: 5.05, priceEffect: 'Debit' as const,
}
const contract = { symbol: 'SPY   260918C00700000', sharesPerContract: 100 }
const quote = { data: { items: [{
  symbol: contract.symbol, 'instrument-type': 'Equity Option', bid: '5.00', ask: '5.10',
  'updated-at': '2026-08-13T13:30:00.000Z',
}] } }
const instrument = { data: {
  symbol: 'SPY', 'option-tick-sizes': [{ value: '0.01' }],
} }
const now = new Date('2026-08-13T13:31:00.000Z')

describe('order market boundary', () => {
  it('accepts the exact contract, fresh inside-market limit, and broker tick', () => {
    expect(orderMarketFromPayloads(option, quote, instrument, contract, now)).toEqual({
      bid: 5, ask: 5.1, observedAt: '2026-08-13T13:30:00.000Z', tickSize: 0.01,
    })
  })

  it('rejects stale, mismatched, off-tick, and outside-market limits', () => {
    expect(() => orderMarketFromPayloads(option, quote, instrument, contract, new Date('2026-08-13T14:00:00Z'))).toThrow('invalid-or-stale')
    expect(() => orderMarketFromPayloads(option, {
      data: { items: [{ ...quote.data.items[0], symbol: 'OTHER' }] },
    }, instrument, contract, now)).toThrow('invalid-or-stale')
    expect(() => orderMarketFromPayloads({ ...option, limitPrice: 5.03 }, quote, {
      data: { symbol: 'SPY', 'option-tick-sizes': [{ value: '0.05' }] },
    }, contract, now)).toThrow('limit-must-use')
    expect(() => orderMarketFromPayloads({ ...option, limitPrice: 5.2 }, quote, instrument, contract, now)).toThrow('limit-outside')
  })

  it('selects threshold-specific broker ticks', () => {
    expect(orderMarketFromPayloads(option, quote, { data: {
      symbol: 'SPY',
      'option-tick-sizes': [{ value: '0.01' }, { value: '0.05', threshold: '3' }],
    } }, contract, now).tickSize).toBe(0.05)
  })
})
