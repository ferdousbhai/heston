import { describe, expect, it } from 'vitest'

import { OrderPlacementSchema, type OrderPlacement } from '../src/server/agent-contracts'
import { assessPortfolioAction } from '../src/server/portfolio-risk'

const longOnlyAccount = {
  positions: [{ direction: 'Long' as const, instrumentType: 'Equity', quantity: 10, symbol: 'SPY' }],
}

describe('portfolio action boundary', () => {
  it('allows a debit vertical on a long-only account', () => {
    const spread: Extract<OrderPlacement, { kind: 'place_vertical_spread_order' }> = {
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'P',
      expiry: '2026-09-18', longStrike: 700, shortStrike: 690,
      quantity: 2, limitPrice: 3, priceEffect: 'Debit',
    }
    expect(assessPortfolioAction(spread, longOnlyAccount, [
      { symbol: 'long', sharesPerContract: 100 },
      { symbol: 'short', sharesPerContract: 100 },
    ])).toEqual({ allowed: true })
  })
  it('allows a bounded debit: the limit is the loss, not a cash-vs-peak-NLV floor', () => {
    const action: Extract<OrderPlacement, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 10,
      priceEffect: 'Debit',
    }
    expect(assessPortfolioAction(action, longOnlyAccount, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }])).toEqual({ allowed: true })

    const larger = { ...action, quantity: 6 }
    expect(assessPortfolioAction(larger, longOnlyAccount, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }])).toEqual({ allowed: true })
  })

  it('rejects naked openings and portfolios whose downside is not contractually bounded', () => {
    const naked: Extract<OrderPlacement, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Sell to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Credit',
    }
    expect(assessPortfolioAction(naked, longOnlyAccount, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }]).allowed).toBe(false)

    const longCall = { ...naked, action: 'Buy to Open' as const, priceEffect: 'Debit' as const }
    const shortAccount = {
      ...longOnlyAccount,
      positions: [{ direction: 'Short' as const, instrumentType: 'Equity Option', quantity: 1, symbol: 'SPY short call' }],
    }
    expect(assessPortfolioAction(longCall, shortAccount, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }]).allowed).toBe(false)
  })

  it('allows only a verified, quantity-bounded close', () => {
    const close: Extract<OrderPlacement, { kind: 'place_equity_order' }> = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Sell to Close', quantity: 10,
      limitPrice: 700, priceEffect: 'Credit',
    }
    expect(assessPortfolioAction(close, longOnlyAccount).allowed).toBe(true)
    expect(assessPortfolioAction({ ...close, quantity: 11 }, longOnlyAccount).allowed).toBe(false)
  })

  it('does not remove long collateral or protection while short exposure remains', () => {
    const accountWithShort = {
      ...longOnlyAccount,
      positions: [
        ...longOnlyAccount.positions,
        { direction: 'Short' as const, instrumentType: 'Equity Option', quantity: 1, symbol: 'SPY short call' },
        { direction: 'Long' as const, instrumentType: 'Equity Option', quantity: 1, symbol: 'SPY long call' },
      ],
    }
    const sellShares: Extract<OrderPlacement, { kind: 'place_equity_order' }> = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Sell to Close', quantity: 10,
      limitPrice: 700, priceEffect: 'Credit',
    }
    const sellLongOption: Extract<OrderPlacement, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 710,
      expiry: '2026-09-18', action: 'Sell to Close', quantity: 1,
      limitPrice: 4, priceEffect: 'Credit',
    }
    const buyBackShort = {
      ...sellLongOption,
      action: 'Buy to Close' as const,
      priceEffect: 'Debit' as const,
      strike: 700,
    }

    expect(assessPortfolioAction(sellShares, accountWithShort).allowed).toBe(false)
    expect(assessPortfolioAction(sellLongOption, accountWithShort, [{
      symbol: 'SPY long call', sharesPerContract: 100,
    }]).allowed).toBe(false)
    expect(assessPortfolioAction(buyBackShort, accountWithShort, [{
      symbol: 'SPY short call', sharesPerContract: 100,
    }]).allowed).toBe(true)
  })

  it('rejects action and price-effect mismatches at the untrusted model boundary', () => {
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 1,
      limitPrice: 700, priceEffect: 'Credit',
    }).success).toBe(false)
  })
})
