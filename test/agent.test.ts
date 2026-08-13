import { describe, expect, it } from 'vitest'

import { BrokerageActionSchema, ChatRequestSchema, ConfirmRequestSchema } from '../src/server/agent-contracts'
import { planAgentReply } from '../src/server/agent-planner'

describe('brokerage input boundary', () => {
  it('accepts a fully specified, bounded option order draft', () => {
    expect(BrokerageActionSchema.parse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 5.2,
      priceEffect: 'Debit',
    }).kind).toBe('place_option_order')
  })

  it('rejects unbounded or incomplete order drafts', () => {
    expect(() => BrokerageActionSchema.parse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: 'tomorrow', action: 'Buy to Open', quantity: 1_000, limitPrice: -1,
      priceEffect: 'Debit',
    })).toThrow()
    expect(BrokerageActionSchema.safeParse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Sell to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Debit',
    }).success).toBe(false)
    expect(BrokerageActionSchema.safeParse({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 2_501,
      limitPrice: 1.999, priceEffect: 'Debit',
    }).success).toBe(false)
  })

  it('requires an explicit confirmation decision and opaque token', () => {
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'short' }).success).toBe(false)
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'a'.repeat(32) }).success).toBe(true)
  })

  it('accepts bounded tastytrade watchlist mutations', () => {
    expect(BrokerageActionSchema.parse({
      kind: 'add_watchlist_symbol', watchlistName: 'Long vol', symbol: 'NVDA',
    }).kind).toBe('add_watchlist_symbol')
    expect(BrokerageActionSchema.safeParse({
      kind: 'remove_watchlist_symbol', watchlistName: '../private', symbol: 'NVDA',
    }).success).toBe(false)
  })

  it('bounds chat input before model invocation', () => {
    expect(ChatRequestSchema.safeParse({ message: 'Why is SPY vol cheap?', selectedSymbol: 'SPY' }).success).toBe(true)
    expect(ChatRequestSchema.safeParse({ message: 'x'.repeat(4_001) }).success).toBe(false)
  })
})

describe('live Dan boundary', () => {
  it('does not turn the demo parser into a live draft when the policy model is unavailable', async () => {
    const configured = { get: async () => 'configured' } as SecretsStoreSecret
    const plan = await planAgentReply({
      APP_MODE: 'live',
      TASTYTRADE_CLIENT_SECRET: configured,
      TASTYTRADE_REFRESH_TOKEN: configured,
    }, {
      message: 'buy 1 SPY 700 call 2026-09-18 at $5.00',
    }, undefined)

    expect(plan.action).toBeNull()
    expect(plan.message).toContain('policy engine is unavailable')
  })
})
