import { describe, expect, it, vi } from 'vitest'

const pi = vi.hoisted(() => ({ stream: vi.fn() }))
vi.mock('@earendil-works/pi-ai/api/openai-responses', () => pi)

import {
  ChatRequestSchema,
  ConfirmRequestSchema,
  DirectAccountActionSchema,
  OrderPlacementSchema,
} from '../src/server/agent-contracts'
import { createPiRuntime } from '../src/server/pi-runtime'

describe('brokerage input boundary', () => {
  it('accepts a fully specified, bounded option order draft', () => {
    expect(OrderPlacementSchema.parse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 5.2,
      priceEffect: 'Debit',
    }).kind).toBe('place_option_order')
  })

  it('accepts only bounded debit verticals and price-only replacements', () => {
    expect(OrderPlacementSchema.parse({
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C',
      expiry: '2026-09-18', longStrike: 700, shortStrike: 710,
      quantity: 2, limitPrice: 3.5, priceEffect: 'Debit',
    }).kind).toBe('place_vertical_spread_order')
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C',
      expiry: '2026-09-18', longStrike: 710, shortStrike: 700,
      quantity: 2, limitPrice: 3.5, priceEffect: 'Debit',
    }).success).toBe(false)
    expect(OrderPlacementSchema.parse({ kind: 'replace_order', orderId: '12345', limitPrice: 3.55 }).kind)
      .toBe('replace_order')
  })

  it('rejects unbounded or incomplete order drafts', () => {
    expect(() => OrderPlacementSchema.parse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: 'tomorrow', action: 'Buy to Open', quantity: 1_000, limitPrice: -1,
      priceEffect: 'Debit',
    })).toThrow()
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Sell to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Debit',
    }).success).toBe(false)
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 2_501,
      limitPrice: 1.999, priceEffect: 'Debit',
    }).success).toBe(false)
  })

  it('requires an explicit confirmation decision and opaque token', () => {
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'short' }).success).toBe(false)
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'a'.repeat(32) }).success).toBe(true)
  })

  it('accepts bounded tastytrade watchlist mutations', () => {
    expect(DirectAccountActionSchema.parse({
      kind: 'add_watchlist_symbols', watchlistName: 'Long vol', symbols: ['NVDA', 'SPY'],
    }).kind).toBe('add_watchlist_symbols')
    expect(DirectAccountActionSchema.safeParse({
      kind: 'remove_watchlist_symbols', watchlistName: '../private', symbols: ['NVDA'],
    }).success).toBe(false)
    expect(DirectAccountActionSchema.safeParse({
      kind: 'delete_watchlist', watchlistName: 'Old ideas',
    }).success).toBe(false)
    expect(DirectAccountActionSchema.safeParse({
      kind: 'rename_watchlist', watchlistName: 'Long vol', newName: 'Core ideas',
    }).success).toBe(false)
  })

  it('bounds chat input before model invocation', () => {
    expect(ChatRequestSchema.safeParse({ message: 'Why is SPY vol cheap?', selectedSymbol: 'SPY' }).success).toBe(true)
    expect(ChatRequestSchema.safeParse({ message: 'x'.repeat(4_001) }).success).toBe(false)
  })
})

describe('pi runtime protocol', () => {
  it('uses Grok 4.6 with high reasoning through the Pi Responses adapter', () => {
    const runtime = createPiRuntime('xai-test-key')
    const context = {
      messages: [],
      systemPrompt: 'Test',
      tools: [],
    }
    runtime.stream(runtime.model, context, {})

    expect(runtime.model).toMatchObject({ id: 'grok-4.6', name: 'Grok 4.6', reasoning: true })
    expect(pi.stream).toHaveBeenCalledWith(runtime.model, context, expect.objectContaining({
      apiKey: 'xai-test-key',
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
    }))
  })
})
