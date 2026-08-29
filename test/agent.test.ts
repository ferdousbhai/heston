import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { JsonObjectSchema } from '../src/domain/json-payload'
import { resetResponsesApi, setResponsesApi, type ResponsesApi } from '../src/server/pi-runtime'
import {
  ChatRequestSchema,
  ConfirmRequestSchema,
  DirectAccountActionSchema,
  OrderPlacementSchema,
} from '../src/server/agent-contracts'
import { preparePendingAction, resolvePendingAction } from '../src/server/agent'
import { brokerApi, resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetInternalWatchlistWriter, setInternalWatchlistWriter } from '../src/server/internal-watchlist'
import { resetTradeGuards, setTradeGuards } from '../src/server/trade-guards'
import { createPiRuntime } from '../src/server/pi-runtime'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

const pi = { stream: vi.fn() } satisfies ResponsesApi

beforeEach(() => setResponsesApi(pi))
afterEach(() => {
  resetResponsesApi()
  resetBrokerApi()
  resetInternalWatchlistWriter()
  resetTradeGuards()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

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
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_equity_order', symbol: '.SPY', action: 'Buy to Open', quantity: 1,
      limitPrice: 1, priceEffect: 'Debit',
    }).success).toBe(false)
  })

  it('requires an explicit confirmation decision and opaque token', () => {
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'short' }).success).toBe(false)
    expect(ConfirmRequestSchema.safeParse({ decision: 'confirm', token: 'a'.repeat(32) }).success).toBe(true)
  })

  it('compares confirmation-token digests in constant time', async () => {
    const token = 'opaque-confirmation-token-1234567890'
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const tokenDigest = btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const timingSafeEqual = vi.fn((left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => {
      const leftBytes = new Uint8Array(ArrayBuffer.isView(left) ? left.buffer : left)
      const rightBytes = new Uint8Array(ArrayBuffer.isView(right) ? right.buffer : right)
      return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index])
    })
    vi.stubGlobal('crypto', { subtle: { digest, timingSafeEqual } })
    const db: D1Database = {
      ...unsupportedDatabase(),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        bind: () => ({
          ...unsupportedStatement(),
          first: async () => {
            if (!sql.startsWith('SELECT payload_json')) throw new Error(`Unexpected first query: ${sql}`)
            return {
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              payload_json: JSON.stringify({ kind: 'place_equity_order' }),
              status: 'pending',
              token_digest: tokenDigest,
            }
          },
          run: async () => {
            if (!sql.includes("SET status = 'denied'")) throw new Error(`Unexpected run query: ${sql}`)
            return d1Result([], 1)
          },
        }),
      }),
    }

    await expect(resolvePendingAction({ DB: db }, 'action-1', { decision: 'deny', token }))
      .resolves.toEqual({ detail: 'Action draft discarded', status: 'denied' })
    expect(timingSafeEqual).toHaveBeenCalledTimes(1)
  })

  it('accepts only bounded mutations for the single internal watchlist', () => {
    expect(DirectAccountActionSchema.parse({
      kind: 'add_watchlist_symbols', symbols: ['NVDA', 'SPY'],
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
    expect(ChatRequestSchema.safeParse({ message: 'Invalid selection', selectedSymbol: '....' }).success).toBe(false)
    expect(ChatRequestSchema.safeParse({ message: 'x'.repeat(4_001) }).success).toBe(false)
  })
})

describe('pi runtime protocol', () => {
  it('uses Grok 4.6 with high reasoning and native web/X through the Pi Responses adapter', async () => {
    const runtime = createPiRuntime(
      'xai-test-key',
      'gateway-test-key',
      'https://gateway.ai.cloudflare.com/v1/account/spice/grok/v1',
      'dan-run-123',
    )
    const context = {
      messages: [],
      systemPrompt: 'Test',
      tools: [],
    }
    const providerItems = [
      { id: 'ws_1', status: 'completed', type: 'web_search_call' },
      {
        arguments: '{"symbols":["NVDA"]}', call_id: 'call_1', id: 'fc_1',
        name: 'read_market_metrics', type: 'function_call',
      },
    ]
    const providerFetch = vi.fn<typeof fetch>(async () => new Response(
      providerItems.map((item) => `data: ${JSON.stringify({ item, type: 'response.output_item.done' })}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } },
    ))
    const callerPayload = vi.fn(<T,>(payload: T) => ({ ...JsonObjectSchema.parse(payload), caller: true }))
    runtime.stream(runtime.model, context, { fetch: providerFetch, onPayload: callerPayload })

    expect(runtime.model).toMatchObject({
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/account/spice/grok/v1',
      id: 'grok-4.6', name: 'Grok 4.6', reasoning: true,
    })
    expect(pi.stream).toHaveBeenCalledWith(runtime.model, context, expect.objectContaining({
      apiKey: 'xai-test-key',
      headers: expect.objectContaining({
        'cf-aig-authorization': 'Bearer gateway-test-key',
        'cf-aig-collect-log': 'true',
        'cf-aig-collect-log-payload': 'true',
        'cf-aig-metadata': JSON.stringify({ app: 'spice', feature: 'dan-agent', run_id: 'dan-run-123' }),
      }),
      reasoningEffort: 'high',
      reasoningSummary: 'auto',
      sessionId: 'dan-run-123',
    }))
    const options = pi.stream.mock.calls[0]?.[2]
    const payload = await options?.onPayload?.(
      { tools: [{ name: 'private_read', type: 'function' }] },
      runtime.model,
    )
    expect(callerPayload).toHaveBeenCalledOnce()
    expect(payload).toMatchObject({
      caller: true,
      tools: [
        { name: 'private_read', type: 'function' },
        { type: 'web_search' },
        { type: 'x_search' },
      ],
    })
    const providerResponse = await options!.fetch!(new Request('https://gateway.example/responses'))
    await providerResponse.text()
    const continued = await options?.onPayload?.({
      input: [
        providerItems[1],
        { call_id: 'call_1', output: '{}', type: 'function_call_output' },
      ],
      tools: [],
    }, runtime.model)
    expect(continued).toMatchObject({
      input: [providerItems[0], providerItems[1], expect.objectContaining({ type: 'function_call_output' })],
    })
  })
})

describe('order confirmation draft', () => {
  it('gives the draft exactly five minutes to live', async () => {
    const binds: unknown[][] = []
    const db: D1Database = {
      ...unsupportedDatabase(),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        first: async () => null,
        run: async () => d1Result([], 0),
        bind: (...values: unknown[]) => ({
          ...unsupportedStatement(),
          first: async () => null,
          run: async () => {
            if (sql.startsWith('INSERT INTO brokerage_actions')) binds.push(values)
            return d1Result([], 1)
          },
        }),
      }),
    }
    setBrokerApi({ ...brokerApi(), resolveAccountNumber: async () => 'TEST123' })
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    setTradeGuards({
      assertOrderMarketSafe: async () => ({ ask: 2, bid: 1, observedAt: '2026-08-26T13:31:00.000Z', tickSize: 0.01 }),
      assertPortfolioActionAllowed: async () => ({ allowed: true, floor: 0, maxLoss: 5, remainingLossBudget: 1_000 }),
    })

    const draft = await preparePendingAction({ DB: db }, {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
      quantity: 1, limitPrice: 5, priceEffect: 'Debit',
    })

    const [, , , createdAt, expiresAt] = binds[0] ?? []
    expect(Date.parse(String(expiresAt)) - Date.parse(String(createdAt))).toBe(5 * 60_000)
    expect(Date.parse(draft.expiresAt)).toBe(Date.parse(String(expiresAt)))
  })
})
