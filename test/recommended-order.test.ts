import { describe, expect, it } from 'vitest'

import { RecommendationSchema } from '../src/domain/market'
import {
  ActionableRecommendedOrderSchema,
  recommendedOrderLabel,
  type RecommendedOrder,
} from '../src/domain/recommended-order'

const CALL = {
  action: 'Buy to Open' as const,
  contract: {
    expiry: '2026-10-16',
    optionType: 'C' as const,
    strike: 225,
    underlying: 'NVDA',
  },
  instrumentType: 'Equity Option' as const,
}

function recommendation(recommendedOrder: RecommendedOrder, direction: 'bullish' | 'bearish' | 'neutral' = 'bullish') {
  return RecommendationSchema.safeParse({
    description: 'A dated catalyst creates a directional setup.',
    direction,
    headline: 'Catalyst changes the setup',
    recommendedOrder,
    risk: 'The catalyst fails to change demand.',
    sources: [],
    symbol: 'NVDA',
  })
}

describe('recommended order contract', () => {
  it('supports a tastytrade-shaped equity leg without execution fields', () => {
    const order = ActionableRecommendedOrderSchema.parse({
      kind: 'equity',
      legs: [{ action: 'Buy to Open', instrumentType: 'Equity', symbol: 'NVDA' }],
    })

    expect(recommendation(order).success).toBe(true)
    expect(recommendedOrderLabel(order)).toBe('Buy to Open NVDA shares')
    expect(order).not.toHaveProperty('quantity')
    expect(order).not.toHaveProperty('limitPrice')
  })

  it('supports long options and validates the symbol, direction, and real expiry', () => {
    const order = { kind: 'equity-option' as const, legs: [CALL] }

    expect(recommendation(order).success).toBe(true)
    expect(recommendedOrderLabel(order)).toBe('Buy to Open NVDA 225C · 2026-10-16')
    expect(recommendation({
      ...order,
      legs: [{ ...CALL, contract: { ...CALL.contract, underlying: 'META' } }],
    }).success).toBe(false)
    expect(recommendation(order, 'bearish').success).toBe(false)
    expect(recommendation({
      ...order,
      legs: [{ ...CALL, contract: { ...CALL.contract, expiry: '2026-02-31' } }],
    }).success).toBe(false)
  })

  it('accepts only correctly ordered debit verticals', () => {
    const order = {
      kind: 'equity-option-vertical' as const,
      legs: [
        CALL,
        {
          action: 'Sell to Open' as const,
          contract: { ...CALL.contract, strike: 240 },
          instrumentType: 'Equity Option' as const,
        },
      ],
    }

    expect(recommendation(order).success).toBe(true)
    expect(recommendedOrderLabel(order)).toBe('NVDA 225/240C debit vertical · 2026-10-16')
    expect(recommendation({
      ...order,
      legs: [
        { ...CALL, contract: { ...CALL.contract, strike: 240 } },
        { ...order.legs[1], contract: { ...CALL.contract, strike: 225 } },
      ],
    }).success).toBe(false)
    // Both legs are one spread or they are not a spread at all.
    expect(recommendation({
      ...order,
      legs: [
        CALL,
        { ...order.legs[1], contract: { ...CALL.contract, expiry: '2026-11-20', strike: 240 } },
      ],
    }).success).toBe(false)
  })

  it('preserves visibly degraded legacy labels without treating them as actionable', () => {
    expect(recommendation({
      kind: 'legacy-unstructured',
      label: 'NVDA 225c 10/16',
    }).success).toBe(true)
    expect(recommendedOrderLabel({
      kind: 'legacy-unstructured',
      label: 'NVDA 225c 10/16',
    })).toBe('Legacy terms · NVDA 225c 10/16')
  })
})
