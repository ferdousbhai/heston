import { z } from 'zod'

import {
  CandlePointSchema,
  CandleSnapshotAccumulator,
  DXLINK_REMOVE_EVENT,
  MAX_INTRADAY_CANDLES,
  MAX_YEAR_CANDLES,
  type CandleFrame,
  type CandlePoint,
} from '../domain/candle'
import { EquitySymbolSchema } from '../domain/instrument'
import { jsonNumber, type JsonObject } from '../domain/json-payload'
import { MAX_LIVE_STREAM_SYMBOLS } from '../domain/watchlist'

export { DXLINK_REMOVE_EVENT }
export {
  DXLINK_SNAPSHOT_BEGIN,
  DXLINK_SNAPSHOT_END,
  DXLINK_SNAPSHOT_SNIP,
  DXLINK_TX_PENDING,
} from '../domain/candle'

const MarketSymbolSchema = EquitySymbolSchema

export const MarketFeedSymbolsSchema = z.array(MarketSymbolSchema)
  .min(1)
  .max(MAX_LIVE_STREAM_SYMBOLS)

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

// One interactive Greeks RPC may briefly subscribe and wait for every requested contract;
// bounding that fan-out keeps its timeout and returned model context predictable.
export const MAX_OPTION_GREEKS_CONTRACTS = 10

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
  greeks: z.array(OptionGreeksEventSchema).max(MAX_OPTION_GREEKS_CONTRACTS),
  impliedVolatilityUnit: z.literal('decimal_ratio'),
  source: z.literal('tastytrade-dxlink'),
})

export type OptionGreeksReadResult = z.infer<typeof OptionGreeksReadResultSchema>

/** Validate the bounded, exact broker streamer symbols accepted by the public DO RPC. */
export function parseOptionStreamerSymbols(value: readonly string[]): string[] {
  const parsed = z.array(OptionStreamerSymbolSchema)
    .min(1)
    .max(MAX_OPTION_GREEKS_CONTRACTS)
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

/**
 * One aggregation period and session scope per subscription. `intraday` is the span a 1D chart
 * draws, so `tho=true` holds it to the regular session; `daily` carries a year of closes and
 * takes the default scope, since a daily bar has no session to exclude.
 */
export const CANDLE_FEED_PERIODS = ['intraday', 'daily'] as const

export type CandleFeedPeriod = typeof CANDLE_FEED_PERIODS[number]

export const CANDLE_PERIOD_SUFFIXES = {
  intraday: '{=5m,tho=true}',
  daily: '{=d}',
} as const satisfies Record<CandleFeedPeriod, string>

export const CANDLE_PERIOD_LIMITS = {
  intraday: MAX_INTRADAY_CANDLES,
  daily: MAX_YEAR_CANDLES,
} as const satisfies Record<CandleFeedPeriod, number>

/**
 * The suffix is part of the subscription identity, and both periods share one upstream channel.
 * Adds, removes, and inbound routing must build and read it the same way or a remove silently
 * misses, the upstream subscription leaks, and two periods merge into one corrupted series.
 */
export function candleStreamerSymbol(symbol: string, period: CandleFeedPeriod = 'intraday'): string {
  return `${symbol}${CANDLE_PERIOD_SUFFIXES[period]}`
}

export function candleSubscription(
  symbol: string,
  fromTime: number,
  period: CandleFeedPeriod = 'intraday',
) {
  return { type: 'Candle' as const, symbol: candleStreamerSymbol(symbol, period), fromTime }
}

/** Recover which series an upstream row belongs to, since one channel carries both. */
export function candleFeedPeriod(streamerSymbol: string): CandleFeedPeriod | undefined {
  const suffixAt = streamerSymbol.indexOf('{')
  if (suffixAt < 0) return undefined
  const suffix = streamerSymbol.slice(suffixAt)
  return CANDLE_FEED_PERIODS.find((period) => CANDLE_PERIOD_SUFFIXES[period] === suffix)
}

export const DailyCandlesReadResultSchema = z.object({
  asOf: z.string().datetime(),
  series: z.array(z.object({
    symbol: MarketSymbolSchema,
    closes: z.array(CandlePointSchema).max(MAX_YEAR_CANDLES),
  })),
  source: z.literal('tastytrade-dxlink'),
})

export type DailyCandlesReadResult = z.infer<typeof DailyCandlesReadResultSchema>

type DailyCandleRequest = {
  reject: (error: Error) => void
  resolve: (series: Map<string, CandlePoint[]>) => void
  series: Map<string, CandlePoint[]>
  settled: boolean
  symbols: string[]
  timeout: ReturnType<typeof setTimeout>
}

export type DailyCandleLease = {
  promise: Promise<Map<string, CandlePoint[]>>
  release: () => void
}

/**
 * The year series is read once and cached, not streamed, so this registry holds the bounded
 * one-shot readers rather than a standing subscription. It mirrors the Greeks registry, but a
 * daily read completes on a finished snapshot per symbol instead of a single event.
 */
export class DailyCandleRequestRegistry {
  private nextRequestId = 0
  private readonly requests = new Map<number, DailyCandleRequest>()
  private readonly symbolRefCounts = new Map<string, number>()
  private readonly snapshots = new CandleSnapshotAccumulator()

  register(symbols: readonly string[], timeoutMs: number): DailyCandleLease {
    const requested = parseMarketFeedSymbols(symbols)
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new Error('Daily candle timeout must be between 1 and 120000 milliseconds.')
    }
    const requestId = ++this.nextRequestId
    let resolvePromise!: (series: Map<string, CandlePoint[]>) => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<Map<string, CandlePoint[]>>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const request: DailyCandleRequest = {
      reject: rejectPromise,
      resolve: resolvePromise,
      series: new Map(),
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
          else {
            this.symbolRefCounts.delete(symbol)
            this.snapshots.forget(symbol)
          }
        }
      },
    }
  }

  /** Feed one upstream daily row; a completed snapshot settles every reader waiting on it. */
  accept(symbol: string, frame: CandleFrame): void {
    if (!this.symbolRefCounts.has(symbol)) return
    const result = this.snapshots.accept(symbol, frame, CANDLE_PERIOD_LIMITS.daily)
    // A daily bar outside a snapshot is that day's close ticking; the cached year does not
    // need it, so only a finished snapshot settles a reader.
    if (result.status !== 'complete') return
    for (const request of this.requests.values()) {
      if (request.settled || !request.symbols.includes(symbol)) continue
      request.series.set(symbol, result.points)
      if (request.series.size !== request.symbols.length) continue
      request.settled = true
      clearTimeout(request.timeout)
      request.resolve(request.series)
    }
  }

  demandSymbols(): Set<string> {
    return new Set(this.symbolRefCounts.keys())
  }

  reset(): void {
    this.snapshots.clear()
  }

  private timeout(requestId: number): void {
    const request = this.requests.get(requestId)
    if (!request || request.settled) return
    request.settled = true
    // A partial year is still worth caching: the reader keeps what arrived rather than
    // failing the whole refresh because one thin symbol never completed its snapshot.
    if (request.series.size) request.resolve(request.series)
    else {
      request.reject(new Error(`Timed out waiting for daily candles: ${request.symbols.join(', ')}.`))
    }
  }
}

/** Validate the entire subscription before normalization can change its cardinality. */
export function parseMarketFeedSymbols(value: readonly string[]): string[] {
  return [...new Set(MarketFeedSymbolsSchema.parse(value))]
}

export function parseRequestedSymbols(url: URL): string[] {
  const parameters = url.searchParams.getAll('symbols')
  if (parameters.length !== 1) throw new Error('Exactly one symbols parameter is required.')
  return parseMarketFeedSymbols(parameters[0]!.split(','))
}

export function isSameOriginWebSocketRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return Boolean(origin && origin === new URL(request.url).origin)
}
