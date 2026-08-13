import { describe, expect, it } from 'vitest'

import {
  fractionalKelly,
  kellyFraction,
  survivalBudget,
} from '../src/domain/portfolio-risk'
import { BrokerageActionSchema, type BrokerageAction } from '../src/server/agent-contracts'
import { answerBrokerageReadRequest, type BrokerageContext } from '../src/server/brokerage-context'
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
  it('allows a bounded debit only within the remaining hard-loss budget', () => {
    const action: Extract<BrokerageAction, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 10,
      priceEffect: 'Debit',
    }
    expect(assessPortfolioAction(action, longOnlyAccount, 100_000, {
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    })).toMatchObject({ allowed: true, maxLoss: 1_000, remainingLossBudget: 5_000 })

    const tooLarge = { ...action, quantity: 6 }
    expect(assessPortfolioAction(tooLarge, longOnlyAccount, 100_000, {
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    })).toMatchObject({ allowed: false, maxLoss: 6_000 })
  })

  it('rejects naked openings and portfolios whose downside is not contractually bounded', () => {
    const naked: Extract<BrokerageAction, { kind: 'place_option_order' }> = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Sell to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Credit',
    }
    expect(assessPortfolioAction(naked, longOnlyAccount, 100_000, {
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }).allowed).toBe(false)

    const longCall = { ...naked, action: 'Buy to Open' as const, priceEffect: 'Debit' as const }
    const shortAccount = {
      ...longOnlyAccount,
      positions: [{ direction: 'Short' as const, instrumentType: 'Equity Option', quantity: 1, symbol: 'SPY short call' }],
    }
    expect(assessPortfolioAction(longCall, shortAccount, 100_000, {
      symbol: 'SPY   260918C00700000', sharesPerContract: 100,
    }).allowed).toBe(false)
  })

  it('allows only a verified, quantity-bounded close', () => {
    const close: Extract<BrokerageAction, { kind: 'place_equity_order' }> = {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Sell to Close', quantity: 10,
      limitPrice: 700, priceEffect: 'Credit',
    }
    expect(assessPortfolioAction(close, longOnlyAccount, 100_000).allowed).toBe(true)
    expect(assessPortfolioAction({ ...close, quantity: 11 }, longOnlyAccount, 100_000).allowed).toBe(false)
  })

  it('rejects action and price-effect mismatches at the untrusted model boundary', () => {
    expect(BrokerageActionSchema.safeParse({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 1,
      limitPrice: 700, priceEffect: 'Credit',
    }).success).toBe(false)
  })
})

describe('Dan doctrine', () => {
  it('keeps survival, Safe Haven, Kelly, patience, liquidity, and epistemic humility in the system layer', () => {
    expect(DAN_SYSTEM_PROMPT).toContain('60% of the sampled high-water value')
    expect(DAN_SYSTEM_PROMPT).toContain('Kelly is a ceiling')
    expect(DAN_SYSTEM_PROMPT).toContain('known-odds dice illustration')
    expect(DAN_SYSTEM_PROMPT).toContain('A safe haven is a payoff')
    expect(DAN_SYSTEM_PROMPT).toContain('dealer balance sheets')
    expect(DAN_SYSTEM_PROMPT).toContain('95% of the time you do not know')
    expect(DAN_SYSTEM_PROMPT).toContain('Wait without embarrassment')
    expect(DAN_SYSTEM_PROMPT).toContain('stationarity and ergodicity assumptions')
    expect(DAN_SYSTEM_PROMPT).toContain('not a physical crash probability')
    expect(DAN_SYSTEM_PROMPT).toContain('not evidence that volatility is underpriced')
  })

  it('sends analytical portfolio questions to Dan instead of the factual read shortcut', () => {
    const account: BrokerageContext = {
      accountNumber: 'TEST123',
      availability: { balances: true, orders: true, positions: true, watchlists: true },
      balances: { netLiquidatingValue: 100_000, cash: 65_000, buyingPower: 65_000 },
      positions: [], orders: [], watchlists: [],
    }
    expect(answerBrokerageReadRequest('How should I size this with Kelly against my portfolio?', account)).toBeUndefined()
    expect(answerBrokerageReadRequest('Show my portfolio', account)).toContain('Net liq')
  })
})
