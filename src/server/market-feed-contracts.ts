import { z } from 'zod'

import { CandlePointSchema, MAX_INTRADAY_CANDLES } from '../domain/candle'
import { EquitySymbolSchema } from '../domain/instrument'
import { jsonNumber, type JsonObject } from '../domain/json-payload'

export const DXLINK_TX_PENDING = 0x1
export const DXLINK_REMOVE_EVENT = 0x2
export const DXLINK_SNAPSHOT_BEGIN = 0x4
export const DXLINK_SNAPSHOT_END = 0x8
export const DXLINK_SNAPSHOT_SNIP = 0x10

const MarketSymbolSchema = EquitySymbolSchema

export const LiveMarketEventSchema = z.object({
  type: z.literal('market'),
  symbol: MarketSymbolSchema,
  price: z.number().finite().positive().optional(),
  change: z.number().finite().optional(),
  bid: z.number().finite().positive().optional(),
  ask: z.number().finite().positive().optional(),
  candle: CandlePointSchema.extend({
    close: z.number().finite().nonnegative(),
    eventFlags: z.number().int().nonnegative(),
  }).optional(),
  candleSnapshot: z.array(CandlePointSchema).max(MAX_INTRADAY_CANDLES).optional(),
  timestamp: z.string().datetime(),
}).superRefine((event, context) => {
  if (event.candle && !(event.candle.eventFlags & DXLINK_REMOVE_EVENT) && event.candle.close <= 0) {
    context.addIssue({ code: 'custom', message: 'A non-remove candle needs a positive close.', path: ['candle', 'close'] })
  }
})

export type LiveMarketEvent = z.infer<typeof LiveMarketEventSchema>

export const MarketFeedStatusSchema = z.object({
  asOf: z.string().datetime(),
  detail: z.string().max(160).optional(),
  state: z.enum(['connecting', 'live', 'reconnecting', 'degraded']),
  type: z.literal('feed-status'),
})

export type MarketFeedStatus = z.infer<typeof MarketFeedStatusSchema>

const MAX_OPTION_GREEKS_SYMBOLS = 10

export const OptionStreamerSymbolSchema = z.string()
  .trim()
  .max(128)
  .regex(/^\.[A-Z0-9.]{1,127}$/)

const OptionGreeksEventSchema = z.object({
  delta: z.number().finite(),
  eventAt: z.string().datetime(),
  gamma: z.number().finite(),
  impliedVolatility: z.number().finite().nonnegative(),
  impliedVolatilityUnit: z.literal('decimal_ratio'),
  optionPrice: z.number().finite().nonnegative(),
  receivedAt: z.string().datetime(),
  rho: z.number().finite(),
  source: z.literal('tastytrade-dxlink'),
  streamerSymbol: OptionStreamerSymbolSchema,
  theta: z.number().finite(),
  vega: z.number().finite(),
})

export type OptionGreeksEvent = z.infer<typeof OptionGreeksEventSchema>

export const OptionGreeksReadResultSchema = z.object({
  asOf: z.string().datetime(),
  greeks: z.array(OptionGreeksEventSchema).max(MAX_OPTION_GREEKS_SYMBOLS),
  impliedVolatilityUnit: z.literal('decimal_ratio'),
  source: z.literal('tastytrade-dxlink'),
})

export type OptionGreeksReadResult = z.infer<typeof OptionGreeksReadResultSchema>

/** Validate the bounded, exact broker streamer symbols accepted by the public DO RPC. */
export function parseOptionStreamerSymbols(value: readonly string[]): string[] {
  const parsed = z.array(OptionStreamerSymbolSchema)
    .min(1)
    .max(MAX_OPTION_GREEKS_SYMBOLS)
    .parse(value)
  return [...new Set(parsed)]
}

/** Parse one compact dxFeed Greeks row, rejecting partial or non-finite observations. */
export function optionGreeksFromRow(
  row: JsonObject,
  receivedAt = new Date(),
): OptionGreeksEvent | undefined {
  const streamerSymbol = OptionStreamerSymbolSchema.safeParse(row.eventSymbol)
  const eventTime = jsonNumber(row.time)
  const optionPrice = jsonNumber(row.price)
  const impliedVolatility = jsonNumber(row.volatility)
  const delta = jsonNumber(row.delta)
  const gamma = jsonNumber(row.gamma)
  const theta = jsonNumber(row.theta)
  const rho = jsonNumber(row.rho)
  const vega = jsonNumber(row.vega)
  if (!streamerSymbol.success
    || eventTime === undefined
    || eventTime <= 0
    || !Number.isSafeInteger(eventTime)
    || eventTime > 8_640_000_000_000_000
    || optionPrice === undefined
    || optionPrice < 0
    || impliedVolatility === undefined
    || impliedVolatility < 0
    || delta === undefined
    || gamma === undefined
    || theta === undefined
    || rho === undefined
    || vega === undefined
    || !Number.isFinite(receivedAt.getTime())) return undefined
  return OptionGreeksEventSchema.parse({
    delta,
    eventAt: new Date(eventTime).toISOString(),
    gamma,
    impliedVolatility,
    impliedVolatilityUnit: 'decimal_ratio',
    optionPrice,
    receivedAt: receivedAt.toISOString(),
    rho,
    source: 'tastytrade-dxlink',
    streamerSymbol: streamerSymbol.data,
    theta,
    vega,
  })
}

type GreeksRequest = {
  events: Map<string, OptionGreeksEvent>
  reject: (error: Error) => void
  resolve: (events: OptionGreeksEvent[]) => void
  settled: boolean
  symbols: string[]
  timeout: ReturnType<typeof setTimeout>
}

export type OptionGreeksLease = {
  promise: Promise<OptionGreeksEvent[]>
  release: () => void
}

/** Account for overlapping bounded RPC waiters while sharing one upstream subscription. */
export class OptionGreeksRequestRegistry {
  private nextRequestId = 0
  private readonly requests = new Map<number, GreeksRequest>()
  private readonly symbolRefCounts = new Map<string, number>()

  register(symbols: readonly string[], timeoutMs: number): OptionGreeksLease {
    const requested = parseOptionStreamerSymbols(symbols)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      throw new Error('Option Greeks timeout must be between 1 and 30000 milliseconds.')
    }
    const requestId = ++this.nextRequestId
    let resolvePromise!: (events: OptionGreeksEvent[]) => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<OptionGreeksEvent[]>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const request: GreeksRequest = {
      events: new Map(),
      reject: rejectPromise,
      resolve: resolvePromise,
      settled: false,
      symbols: requested,
      timeout: setTimeout(() => this.timeout(requestId), timeoutMs),
    }
    this.requests.set(requestId, request)
    for (const symbol of requested) {
      this.symbolRefCounts.set(symbol, (this.symbolRefCounts.get(symbol) ?? 0) + 1)
    }
    let released = false
    return {
      promise,
      release: () => {
        if (released) return
        released = true
        clearTimeout(request.timeout)
        this.requests.delete(requestId)
        for (const symbol of requested) {
          const count = (this.symbolRefCounts.get(symbol) ?? 1) - 1
          if (count > 0) this.symbolRefCounts.set(symbol, count)
          else this.symbolRefCounts.delete(symbol)
        }
      },
    }
  }

  accept(event: OptionGreeksEvent): void {
    for (const request of this.requests.values()) {
      if (request.settled || !request.symbols.includes(event.streamerSymbol)) continue
      request.events.set(event.streamerSymbol, event)
      if (request.events.size !== request.symbols.length) continue
      request.settled = true
      clearTimeout(request.timeout)
      request.resolve(request.symbols.map((symbol) => request.events.get(symbol)!))
    }
  }

  demandSymbols(): Set<string> {
    return new Set(this.symbolRefCounts.keys())
  }

  get activeRequestCount(): number {
    return this.requests.size
  }

  private timeout(requestId: number): void {
    const request = this.requests.get(requestId)
    if (!request || request.settled) return
    request.settled = true
    const missing = request.symbols.filter((symbol) => !request.events.has(symbol))
    request.reject(new Error(`Timed out waiting for option Greeks: ${missing.join(', ')}.`))
  }
}

export function candleSubscription(symbol: string, fromTime: number) {
  return { type: 'Candle' as const, symbol: `${symbol}{=5m,tho=true}`, fromTime }
}

export function parseRequestedSymbols(url: URL, limit = 100): string[] {
  return [...new Set((url.searchParams.get('symbols') ?? '')
    .split(',')
    .map((symbol) => MarketSymbolSchema.safeParse(symbol))
    .flatMap((result) => result.success ? [result.data] : []))]
    .slice(0, limit)
}

export function isSameOriginWebSocketRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return Boolean(origin && origin === new URL(request.url).origin)
}
