import { describe, expect, it, vi } from 'vitest'

import { demoTickers } from '../src/domain/demo'
import { BrokerageActionSchema, ChatRequestSchema, ConfirmRequestSchema } from '../src/server/agent-contracts'
import { planAgentReply } from '../src/server/agent-planner'
import { createPiRuntime } from '../src/server/pi-runtime'

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
  const configured = { get: async () => 'configured' } as SecretsStoreSecret

  it('does not turn the demo parser into a live draft when the policy model is unavailable', async () => {
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

  it('uses a simple structured envelope and validates its serialized action with Zod', async () => {
    const run = vi.fn().mockResolvedValue({
      response: {
        message: 'Cash is valid while the edge is unknown.',
        action_json: '',
      },
    })
    const plan = await planAgentReply({
      AI: { run } as unknown as Ai,
      APP_MODE: 'live',
      TASTYTRADE_CLIENT_SECRET: configured,
      TASTYTRADE_REFRESH_TOKEN: configured,
    }, { message: 'State your Kelly rule.' }, undefined)

    expect(plan).toEqual({ message: 'Cash is valid while the edge is unknown.', action: null })
    expect(run.mock.calls[0]?.[1]?.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: {
        properties: { message: { type: 'string' }, action_json: { type: 'string' } },
        required: ['message', 'action_json'],
      },
    })
  })

  it('rejects a model action that does not satisfy the brokerage contract', async () => {
    const run = vi.fn().mockResolvedValue({
      response: {
        message: 'Drafted.',
        action_json: JSON.stringify({ kind: 'place_option_order', underlying: 'SPY' }),
      },
    })

    await expect(planAgentReply({
      AI: { run } as unknown as Ai,
      APP_MODE: 'live',
      TASTYTRADE_CLIENT_SECRET: configured,
      TASTYTRADE_REFRESH_TOKEN: configured,
    }, { message: 'Draft something incomplete.' }, undefined)).rejects.toThrow()
  })
})

describe('pi runtime protocol', () => {
  it('streams a demo brokerage draft as a real pi tool call', async () => {
    const runtime = createPiRuntime(undefined, demoTickers.find((ticker) => ticker.symbol === 'SPY'))
    const stream = runtime.stream(runtime.model, {
      messages: [{
        content: 'Buy 1 SPY 700 call expiring 2026-09-18 at $5.20',
        role: 'user',
        timestamp: Date.now(),
      }],
      systemPrompt: 'Test',
      tools: [],
    }, {})
    const eventTypes: string[] = []
    for await (const event of stream) eventTypes.push(event.type)
    const result = await stream.result()

    expect(eventTypes).toEqual(['start', 'toolcall_start', 'toolcall_delta', 'toolcall_end', 'done'])
    expect(result.stopReason).toBe('toolUse')
    expect(result.content).toContainEqual(expect.objectContaining({
      name: 'prepare_brokerage_action',
      type: 'toolCall',
    }))
  })
})
