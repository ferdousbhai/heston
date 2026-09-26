import { describe, expect, it } from 'vitest'

import { BrokerRefusalError } from '../src/server/caller-visible-error'
import { orderMarketFromPayloads, QUOTE_MAX_AGE_MS, spreadOrderMarketFromPayloads } from '../src/server/order-market'

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

function refusal(attempt: () => void): BrokerRefusalError {
  try {
    attempt()
  } catch (error) {
    if (error instanceof BrokerRefusalError) return error
    throw error
  }
  throw new Error('expected a broker refusal')
}

function optionQuote(bid: number, ask: number) {
  return { data: { items: [{
    ...quote.data.items[0],
    ask: ask.toFixed(2),
    bid: bid.toFixed(2),
  }] } }
}

describe('order market boundary', () => {
  it('accepts the exact contract, fresh inside-market limit, and broker tick', () => {
    expect(orderMarketFromPayloads(option, quote, instrument, contract, now)).toEqual({
      bid: 5, ask: 5.1, observedAt: '2026-08-13T13:30:00.000Z', tickSize: 0.01,
    })
  })

  it('uses finite Equity thresholds as inclusive floors', () => {
    const equity = {
      kind: 'place_equity_order' as const,
      symbol: 'SPY', action: 'Buy to Open' as const, quantity: 1,
      limitPrice: 10, priceEffect: 'Debit' as const,
    }
    const equityInstrument = { data: {
      symbol: 'SPY',
      'tick-sizes': { symbol: 'SPY', threshold: '1', value: '0.01' },
    } }
    const equityQuote = (bid: string, ask: string) => ({ data: { items: [{
      symbol: 'SPY', 'instrument-type': 'Equity', bid, ask,
      'updated-at': '2026-08-13T13:30:00.000Z',
    }] } })

    expect(orderMarketFromPayloads(
      equity, equityQuote('9.99', '10.01'), equityInstrument, undefined, now,
    ).tickSize).toBe(0.01)
    expect(orderMarketFromPayloads(
      { ...equity, limitPrice: 1 }, equityQuote('0.99', '1.01'), equityInstrument, undefined, now,
    ).tickSize).toBe(0.01)
    expect(() => orderMarketFromPayloads(
      { ...equity, limitPrice: 0.99 }, equityQuote('0.98', '1.00'), equityInstrument, undefined, now,
    )).toThrow('ambiguous-tick-rules')

    const equityWithBase = { data: {
      symbol: 'SPY',
      'tick-sizes': [{ value: '0.0001' }, { threshold: '1', value: '0.01' }],
    } }
    expect(orderMarketFromPayloads(
      { ...equity, limitPrice: 0.99 }, equityQuote('0.98', '1.00'), equityWithBase, undefined, now,
    ).tickSize).toBe(0.0001)
  })

  it('checks a limit against a quote at most QUOTE_MAX_AGE_MS old', () => {
    // The quote was observed at 13:30:00.
    expect(() => orderMarketFromPayloads(option, quote, instrument, contract, new Date('2026-08-13T13:32:00.000Z'))).not.toThrow()
    expect(() => orderMarketFromPayloads(option, quote, instrument, contract, new Date('2026-08-13T13:32:00.001Z'))).toThrow('invalid-or-stale')
    expect(QUOTE_MAX_AGE_MS).toBe(2 * 60_000)
  })

  it('rejects stale, mismatched, off-tick, and outside-market limits', () => {
    expect(() => orderMarketFromPayloads(option, quote, instrument, contract, new Date('2026-08-13T14:00:00Z'))).toThrow('invalid-or-stale')
    expect(() => orderMarketFromPayloads(option, {
      data: { items: [{ ...quote.data.items[0], symbol: 'OTHER' }] },
    }, instrument, contract, now)).toThrow('invalid-or-stale')
    const offTick = refusal(() => orderMarketFromPayloads({ ...option, limitPrice: 5.03 }, quote, {
      data: { symbol: 'SPY', 'option-tick-sizes': [{ value: '0.05' }] },
    }, contract, now))
    expect(offTick).toMatchObject({ check: 'limit-off-tick', untrustedBrokerData: { tickSize: 0.05 } })
    expect(offTick.message).not.toContain('0.05')
    // The quote the limit fell outside is the broker's figure: in the labelled field, not the message.
    const outside = refusal(() => orderMarketFromPayloads({ ...option, limitPrice: 5.2 }, quote, instrument, contract, now))
    expect(outside).toMatchObject({ check: 'limit-outside-quote', untrustedBrokerData: { ask: 5.1, bid: 5 } })
    expect(outside.message).toContain('limit-outside-quote')
    expect(outside.message).not.toMatch(/5\.0|5\.1/)
  })

  it('uses exclusive upper thresholds and accepts both provider unbounded forms', () => {
    const infinityTier = { data: {
      symbol: 'SPY',
      'option-tick-sizes': [
        { value: '0.05', threshold: '3' },
        { value: '0.10', threshold: 'Infinity' },
      ],
    } }
    expect(orderMarketFromPayloads(
      { ...option, limitPrice: 2.95 }, optionQuote(2.9, 3.1), infinityTier, contract, now,
    ).tickSize).toBe(0.05)
    expect(orderMarketFromPayloads(
      { ...option, limitPrice: 3 }, optionQuote(2.9, 3.1), infinityTier, contract, now,
    ).tickSize).toBe(0.1)
    expect(refusal(() => orderMarketFromPayloads(
      { ...option, limitPrice: 5.05 }, quote, infinityTier, contract, now,
    ))).toMatchObject({ check: 'limit-off-tick', untrustedBrokerData: { tickSize: 0.1 } })

    const missingThresholdTier = { data: {
      symbol: 'SPY',
      'option-tick-sizes': [
        { value: '0.05', threshold: '5' },
        { value: '0.25' },
      ],
    } }
    expect(orderMarketFromPayloads(
      { ...option, limitPrice: 5 }, optionQuote(4.9, 5.1), missingThresholdTier, contract, now,
    ).tickSize).toBe(0.25)
  })

  it('fails closed on incomplete or ambiguous tick tiers', () => {
    expect(() => orderMarketFromPayloads(option, quote, { data: {
      symbol: 'SPY',
      'option-tick-sizes': [{ value: '0.05', threshold: '3' }],
    } }, contract, now)).toThrow('ambiguous-tick-rules')
    expect(() => orderMarketFromPayloads(option, quote, { data: {
      symbol: 'SPY',
      'option-tick-sizes': [{ value: '0.05' }, { value: '0.10', threshold: 'Infinity' }],
    } }, contract, now)).toThrow('ambiguous-tick-rules')
    expect(() => orderMarketFromPayloads(option, quote, { data: {
      symbol: 'SPY',
      'option-tick-sizes': [
        { value: '0.01', threshold: '3' },
        { value: '0.05', threshold: '3' },
        { value: '0.10' },
      ],
    } }, contract, now)).toThrow('ambiguous-tick-rules')
  })

  it('prices a debit vertical from the exact two-leg natural market', () => {
    const spread = {
      kind: 'place_vertical_spread_order' as const,
      underlying: 'SPY', optionType: 'C' as const, expiry: '2026-09-18',
      longStrike: 700, shortStrike: 710, quantity: 1, limitPrice: 2.55,
      priceEffect: 'Debit' as const,
    }
    const contracts = [
      { symbol: 'SPY   260918C00700000', sharesPerContract: 100 },
      { symbol: 'SPY   260918C00710000', sharesPerContract: 100 },
    ]
    const quotes = { data: { items: [
      { symbol: contracts[0]!.symbol, 'instrument-type': 'Equity Option', bid: '5.00', ask: '5.10', 'updated-at': now.toISOString() },
      { symbol: contracts[1]!.symbol, 'instrument-type': 'Equity Option', bid: '2.50', ask: '2.60', 'updated-at': now.toISOString() },
    ] } }
    const tieredInstrument = { data: {
      symbol: 'SPY',
      'option-tick-sizes': [
        { value: '0.05', threshold: '3' },
        { value: '0.10', threshold: 'Infinity' },
      ],
    } }
    expect(spreadOrderMarketFromPayloads(spread, quotes, tieredInstrument, contracts, now)).toEqual({
      bid: 2.4, ask: 2.6, observedAt: now.toISOString(), tickSize: 0.05,
    })
  })
})
