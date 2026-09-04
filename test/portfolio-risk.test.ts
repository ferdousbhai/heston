import { describe, expect, it } from 'vitest'

import { survivalBudget } from '../src/domain/portfolio-risk'
import { OrderPlacementSchema, type OrderPlacement } from '../src/server/agent-contracts'
import {
  buildAgentRuntimeContext,
  type BrokerageContext,
} from '../src/server/brokerage-context'
import { assessPortfolioAction } from '../src/server/portfolio-risk'

const longOnlyAccount = {
  cash: 65_000,
  liveOrderCount: 0,
  netLiquidatingValue: 100_000,
  positions: [{ direction: 'Long' as const, instrumentType: 'Equity', quantity: 10, symbol: 'SPY' }],
}

describe('survival math', () => {
  it('retains 60% of the recorded high-water value rather than resetting after a loss', () => {
    expect(survivalBudget(100_000, 65_000, 5_000)).toMatchObject({
      allowed: true,
      floor: 60_000,
      remainingLossBudget: 5_000,
    })
    expect(survivalBudget(100_000, 65_000, 5_001).allowed).toBe(false)
    expect(survivalBudget(60_000, 36_000).floor).toBe(36_000)
  })
})

describe('portfolio action boundary', () => {
  it('sizes a debit vertical by its net debit and verified multiplier', () => {
    const spread: Extract<OrderPlacement, { kind: 'place_vertical_spread_order' }> = {
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'P',
      expiry: '2026-09-18', longStrike: 700, shortStrike: 690,
      quantity: 2, limitPrice: 3, priceEffect: 'Debit',
    }
    expect(assessPortfolioAction(spread, longOnlyAccount, 100_000, [
      { symbol: 'long', sharesPerContract: 100 },
      { symbol: 'short', sharesPerContract: 100 },
    ])).toMatchObject({ allowed: true, maxLoss: 600 })
  })
  it('allows a bounded debit only within the remaining hard-loss budget', () => {
    const action: Extract<OrderPlacement, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 10,
      priceEffect: 'Debit',
    }
    expect(assessPortfolioAction(action, longOnlyAccount, 100_000, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }])).toMatchObject({ allowed: true, maxLoss: 1_000, remainingLossBudget: 5_000 })

    const tooLarge = { ...action, quantity: 6 }
    expect(assessPortfolioAction(tooLarge, longOnlyAccount, 100_000, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }])).toMatchObject({ allowed: false, maxLoss: 6_000 })
  })

  it('rejects naked openings and portfolios whose downside is not contractually bounded', () => {
    const naked: Extract<OrderPlacement, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Sell to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Credit',
    }
    expect(assessPortfolioAction(naked, longOnlyAccount, 100_000, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }]).allowed).toBe(false)

    const longCall = { ...naked, action: 'Buy to Open' as const, priceEffect: 'Debit' as const }
    const shortAccount = {
      ...longOnlyAccount,
      positions: [{ direction: 'Short' as const, instrumentType: 'Equity Option', quantity: 1, symbol: 'SPY short call' }],
    }
    expect(assessPortfolioAction(longCall, shortAccount, 100_000, [{
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }]).allowed).toBe(false)
  })

  it('allows only a verified, quantity-bounded close', () => {
    const close: Extract<OrderPlacement, { kind: 'place_equity_order' }> = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Sell to Close', quantity: 10,
      limitPrice: 700, priceEffect: 'Credit',
    }
    expect(assessPortfolioAction(close, longOnlyAccount, 100_000).allowed).toBe(true)
    expect(assessPortfolioAction({ ...close, quantity: 11 }, longOnlyAccount, 100_000).allowed).toBe(false)
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

    expect(assessPortfolioAction(sellShares, accountWithShort, 100_000).allowed).toBe(false)
    expect(assessPortfolioAction(sellLongOption, accountWithShort, 100_000, [{
      symbol: 'SPY long call', sharesPerContract: 100,
    }]).allowed).toBe(false)
    expect(assessPortfolioAction(buyBackShort, accountWithShort, 100_000, [{
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

describe('model context', () => {
  // The doctrine's own contract is pinned in doctrine.test.ts, against PORTFOLIO_POLICY itself
  // rather than a spelled-out percentage that can drift from it.
  it('builds compact model context without exposing account identity', () => {
    const account: BrokerageContext = {
      accountNumber: 'SECRET123',
      asOf: '2026-08-13T12:00:00.000Z',
      source: 'tastytrade',
      balances: {
        netLiquidatingValue: 100_000,
        cashBalance: 70_000, cashAvailableToWithdraw: 65_000, availableTradingFunds: 62_000,
        equityBuyingPower: 160_000, derivativeBuyingPower: 80_000, dayTradingBuyingPower: 320_000,
      },
      positions: [{
        direction: 'Long', instrumentType: 'Equity Option', quantity: 2,
        symbol: 'SPY option', underlying: 'SPY',
      }],
      orders: [],
      liveOrders: [],
    }
    const context = buildAgentRuntimeContext(account)

    expect(context).toMatchObject({
      asOf: '2026-08-13T12:00:00.000Z',
      source: 'tastytrade',
      balances: {
        availableTradingFunds: 62_000,
        cashAvailableToWithdraw: 65_000,
        cashBalance: 70_000,
        dayTradingBuyingPower: 320_000,
        derivativeBuyingPower: 80_000,
        equityBuyingPower: 160_000,
        netLiquidatingValue: 100_000,
      },
      orders: [],
    })
    expect(JSON.stringify(context)).not.toContain('SECRET123')
    expect(context).toHaveProperty('balances')
    expect(JSON.stringify(context)).not.toContain('"cash":')
    expect(JSON.stringify(context)).not.toContain('"buyingPower":')
  })

})
