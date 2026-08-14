import { describe, expect, it } from 'vitest'

import {
  fractionalKelly,
  kellyFraction,
  survivalBudget,
} from '../src/domain/portfolio-risk'
import { OrderPlacementSchema, type OrderPlacement } from '../src/server/agent-contracts'
import {
  buildAgentRuntimeContext,
  type BrokerageContext,
} from '../src/server/brokerage-context'
import { DAN_SYSTEM_PROMPT } from '../src/server/dan-doctrine'
import { assessPortfolioAction } from '../src/server/portfolio-risk'

const longOnlyAccount = {
  cash: 65_000,
  liveOrderCount: 0,
  netLiquidatingValue: 100_000,
  positions: [{ direction: 'Long' as const, instrumentType: 'Equity', quantity: 10, symbol: 'SPY' }],
}

describe('Kelly and survival math', () => {
  it('uses full Kelly as a ceiling and defaults to conservative fractional Kelly', () => {
    expect(kellyFraction(0.6, 2)).toBeCloseTo(0.4)
    expect(fractionalKelly(0.6, 2)).toBeCloseTo(0.1)
  })

  it('returns a zero allocation when the edge is absent or cannot be estimated', () => {
    expect(kellyFraction(undefined, 2)).toBe(0)
    expect(kellyFraction(0.3, 1)).toBe(0)
    expect(kellyFraction(1.2, 2)).toBe(0)
  })

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

describe('Dan doctrine', () => {
  it('keeps survival, Safe Haven, Kelly, patience, liquidity, and epistemic humility in the system layer', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('60% of the sampled high-water value')
    expect(DAN_SYSTEM_PROMPT).toContain('Kelly is a ceiling')
    expect(DAN_SYSTEM_PROMPT).toContain('may relay an exact user-directed order without endorsement')
    expect(DAN_SYSTEM_PROMPT).toContain('known-odds dice illustration')
    expect(DAN_SYSTEM_PROMPT).toContain('A safe haven is a payoff')
    expect(DAN_SYSTEM_PROMPT).toContain('positively convex, bounded-loss exposure')
    expect(DAN_SYSTEM_PROMPT).toContain('wrong without threatening survival')
    expect(DAN_SYSTEM_PROMPT).toContain('dealer balance sheets')
    expect(DAN_SYSTEM_PROMPT).toContain('95% of the time you do not know')
    expect(DAN_SYSTEM_PROMPT).toContain('Wait without embarrassment')
    expect(DAN_SYSTEM_PROMPT).toContain('stationarity and ergodicity assumptions')
    expect(DAN_SYSTEM_PROMPT).toContain('not a physical crash probability')
    expect(DAN_SYSTEM_PROMPT).toContain('not evidence that volatility is underpriced')
  })

  it('builds compact model context with balances and market metrics for open-position tickers', () => {
    const account: BrokerageContext = {
      accountNumber: 'SECRET123',
      asOf: '2026-08-13T12:00:00.000Z',
      source: 'tastytrade',
      completeness: { ordersTruncated: false, positionsTruncated: false, tradesTruncated: false },
      availability: { balances: true, orders: true, positions: true, trades: true },
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
      recentTrades: [{
        action: 'Buy to Open', executedAt: '2026-08-12T15:00:00Z',
        instrumentType: 'Equity Option', orderId: '9001', price: 1.2,
        quantity: 2, symbol: 'SPY option', underlying: 'SPY',
      }],
    }
    const context = buildAgentRuntimeContext(account, [{
      symbol: 'SPY', price: 700, changePercent: 1.2, ivIndex: 18,
      ivRank: 25, ivPercentile: 30, liquidity: 5, earningsDate: null,
    }], {
      symbol: 'NVDA', price: 180, changePercent: -0.5, ivIndex: 40,
      ivRank: 60, ivPercentile: 65, liquidity: 4, earningsDate: '2026-08-26',
    })

    expect(context).toMatchObject({
      asOf: '2026-08-13T12:00:00.000Z',
      source: 'tastytrade',
      completeness: { ordersTruncated: false, positionsTruncated: false, tradesTruncated: false },
      balances: {
        availableTradingFunds: 62_000,
        cashAvailableToWithdraw: 65_000,
        cashBalance: 70_000,
        dayTradingBuyingPower: 320_000,
        derivativeBuyingPower: 80_000,
        equityBuyingPower: 160_000,
        netLiquidatingValue: 100_000,
      },
      marketMetrics: {
        SPY: { price: 700, ivIndex: 18, ivRank: 25, ivPercentile: 30, liquidity: 5 },
        NVDA: { price: 180, ivIndex: 40, ivRank: 60, ivPercentile: 65, liquidity: 4 },
      },
      orders: [],
      recentTrades: [{ orderId: '9001', symbol: 'SPY option' }],
    })
    expect(JSON.stringify(context)).not.toContain('SECRET123')
    expect(context).toHaveProperty('balances')
    expect(JSON.stringify(context)).not.toContain('"cash":')
    expect(JSON.stringify(context)).not.toContain('"buyingPower":')
  })

  it('keeps selected-symbol metrics available without brokerage data', () => {
    expect(buildAgentRuntimeContext(undefined, [], {
      symbol: 'SPY', price: 700, changePercent: 1.2, ivIndex: 18,
      ivRank: 25, ivPercentile: 30, liquidity: 5, earningsDate: null,
    })).toMatchObject({
      selectedSymbol: 'SPY',
      marketMetrics: { SPY: { price: 700, ivRank: 25 } },
    })
  })
})
