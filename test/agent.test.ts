import { describe, expect, it } from 'vitest'

import { BrokerageActionSchema, ChatRequestSchema, ConfirmRequestSchema } from '../src/server/agent-contracts'

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
  })

  it('requires an explicit confirmation decision and opaque token', () => {
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'short' }).success).toBe(false)
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'a'.repeat(32) }).success).toBe(true)
  })

  it('bounds chat input before model invocation', () => {
    expect(ChatRequestSchema.safeParse({ message: 'Why is SPY vol cheap?', selectedSymbol: 'SPY' }).success).toBe(true)
    expect(ChatRequestSchema.safeParse({ message: 'x'.repeat(4_001) }).success).toBe(false)
  })
})
