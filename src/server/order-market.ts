import { type FreshOrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import {
  envelopeRows,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { type EquityOptionContract } from './option-contract'
import { tastytradeTickSizes } from './tastytrade-tick-sizes'
import { brokerApi } from './tastytrade'
import { BrokerRefusalError, CallerVisibleError } from './caller-visible-error'

type OrderAction = FreshOrderPlacement

/**
 * The market guard's refusals. Each code is this repository's own and carries no quote value,
 * so it reaches the caller as it stands. The two refusals whose explanation is a broker figure
 * (the tick the limit must use, the bid/ask it fell outside) are `BrokerRefusalError`s instead,
 * with that figure in the labelled untrusted field rather than in the message.
 */
class OrderMarketError extends CallerVisibleError {
  constructor(code: string) {
    super(code)
    this.name = 'OrderMarketError'
  }
}

function offTick(tickSize: number): BrokerRefusalError {
  return new BrokerRefusalError(
    'limit-off-tick',
    'OrderMarket:limit-off-tick: the limit price is not a multiple of the instrument tick size.',
    { tickSize },
  )
}

function outsideQuote(bid: number, ask: number): BrokerRefusalError {
  return new BrokerRefusalError(
    'limit-outside-quote',
    'OrderMarket:limit-outside-quote: the limit price is outside the current bid/ask.',
    { ask, bid },
  )
}

export type OrderMarket = {
  ask: number
  bid: number
  observedAt: string
  tickSize: number
}

/**
 * How far a provider timestamp may sit ahead of this Worker's clock before it is treated as
 * invalid rather than as clock skew. No provider figure or written policy sets it; it is named
 * once so every broker-timestamp check shares it.
 */
export const BROKER_CLOCK_SKEW_MS = 60_000
/**
 * The oldest quote a limit price may be checked against. No provider constraint or written
 * risk policy fixes this figure yet; it is named here so that reason has one place to live.
 */
const QUOTE_MAX_AGE_MS = 15 * 60_000

/** A two-sided quote that is present, ordered, and fresh at `now`; anything else is refused. */
function validatedQuote(quote: JsonObject | undefined, now: Date) {
  const bid = jsonNumber(quote?.bid)
  const ask = jsonNumber(quote?.ask)
  const observed = Date.parse(jsonText(quote?.['updated-at'] ?? quote?.updatedAt) ?? '')
  if (bid === undefined || ask === undefined || bid < 0 || ask <= 0 || bid > ask
    || !Number.isFinite(observed)
    || observed > now.getTime() + BROKER_CLOCK_SKEW_MS
    || now.getTime() - observed > QUOTE_MAX_AGE_MS) {
    throw new OrderMarketError('OrderMarketQuote:invalid-or-stale')
  }
  return { ask, bid, observed }
}

/** Market-data endpoints may also answer with a single `data` object rather than a collection. */
function quoteRows(payload: JsonValue): JsonValue[] | undefined {
  const rows = envelopeRows(payload)
  if (rows) return rows
  const body = jsonObject(payload)
  const data = jsonObject(body?.data ?? payload)
  return data ? [data] : undefined
}

function recordRows(payload: JsonValue, label: string): JsonObject[] {
  const rows = quoteRows(payload)
  if (!rows?.length) throw new OrderMarketError(`${label}:invalid-response`)
  return rows.map((value) => {
    const row = jsonObject(value)
    if (!row) throw new OrderMarketError(`${label}:invalid-response`)
    return row
  })
}

function exactlyOneRecord(payload: JsonValue, label: string): JsonObject {
  const rows = recordRows(payload, label)
  if (rows.length !== 1) throw new OrderMarketError(`${label}:invalid-response`)
  return rows[0]!
}

function tickSizeAt(rules: JsonValue, price: number, kind: 'equity' | 'option'): number {
  let parsed
  try {
    parsed = tastytradeTickSizes(rules, 'OrderMarket')
  } catch {
    throw new OrderMarketError('OrderMarket:invalid-tick-rules')
  }
  if (!parsed.length) throw new OrderMarketError('OrderMarket:missing-tick-rules')

  const unbounded = parsed.filter((rule) => rule.threshold === null)
  const bounded = parsed
    .filter((rule): rule is typeof rule & { threshold: number } => rule.threshold !== null)
    .sort((left, right) => left.threshold - right.threshold)
  const uniqueThresholds = new Set(bounded.map((rule) => rule.threshold))
  if (unbounded.length > 1 || uniqueThresholds.size !== bounded.length) {
    throw new OrderMarketError('OrderMarket:ambiguous-tick-rules')
  }

  if (kind === 'equity') {
    // Equity tiers are finite lower floors. Some responses contain only the
    // $1-and-up rule, so prices below the first floor fail closed without a base.
    const match = [...bounded].reverse().find((rule) => price >= rule.threshold)
    if (match) return match.value
    if (unbounded.length === 1) return unbounded[0]!.value
    throw new OrderMarketError('OrderMarket:ambiguous-tick-rules')
  }

  // tastytrade thresholds are exclusive upper cutoffs. The unbounded tier
  // applies at the cutoff and above (for example, .05 below $3 and .10 at $3).
  if (unbounded.length !== 1) throw new OrderMarketError('OrderMarket:ambiguous-tick-rules')
  return bounded.find((rule) => price < rule.threshold)?.value ?? unbounded[0]!.value
}

function isTickAligned(price: number, tickSize: number): boolean {
  const units = price / tickSize
  return Math.abs(units - Math.round(units)) <= 1e-7
}

export function orderMarketFromPayloads(
  action: OrderAction,
  quotePayload: JsonValue,
  instrumentPayload: JsonValue,
  resolvedOption: EquityOptionContract | undefined,
  now = new Date(),
): OrderMarket {
  if (action.kind === 'place_vertical_spread_order') throw new OrderMarketError('OrderMarket:use-spread-market')
  const expectedSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!expectedSymbol) throw new OrderMarketError('OrderMarket:missing-contract')
  const expectedType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const quote = exactlyOneRecord(quotePayload, 'OrderMarketQuote')
  const responseSymbol = jsonText(quote.symbol)
  const responseType = jsonText(quote['instrument-type'] ?? quote.instrumentType)
  if (responseSymbol !== expectedSymbol || responseType !== expectedType) {
    throw new OrderMarketError('OrderMarketQuote:invalid-or-stale')
  }
  const { ask, bid, observed: observedTime } = validatedQuote(quote, now)

  const instrument = exactlyOneRecord(instrumentPayload, 'OrderMarketInstrument')
  if (jsonText(instrument.symbol)?.toUpperCase() !== (action.kind === 'place_option_order' ? action.underlying : action.symbol)) {
    throw new OrderMarketError('OrderMarketInstrument:mismatch')
  }
  const tickSize = tickSizeAt(
    action.kind === 'place_option_order' ? instrument['option-tick-sizes'] : instrument['tick-sizes'],
    action.limitPrice,
    action.kind === 'place_option_order' ? 'option' : 'equity',
  )
  if (!isTickAligned(action.limitPrice, tickSize)) throw offTick(tickSize)
  if (action.limitPrice < bid || action.limitPrice > ask) {
    throw outsideQuote(bid, ask)
  }
  return { ask, bid, observedAt: new Date(observedTime).toISOString(), tickSize }
}

export function spreadOrderMarketFromPayloads(
  action: Extract<OrderAction, { kind: 'place_vertical_spread_order' }>,
  quotePayload: JsonValue,
  instrumentPayload: JsonValue,
  resolvedOptions: readonly EquityOptionContract[],
  now = new Date(),
): OrderMarket {
  if (resolvedOptions.length !== 2) throw new OrderMarketError('OrderMarket:missing-spread-contracts')
  const quotes = recordRows(quotePayload, 'OrderMarketQuote')
  if (quotes.length !== 2) throw new OrderMarketError('OrderMarketQuote:invalid-response')
  const bySymbol = new Map(quotes.map((quote) => [jsonText(quote.symbol), quote]))
  const parsed = resolvedOptions.map((contract) => {
    const quote = bySymbol.get(contract.symbol)
    if (jsonText(quote?.['instrument-type'] ?? quote?.instrumentType) !== 'Equity Option') {
      throw new OrderMarketError('OrderMarketQuote:invalid-or-stale')
    }
    const { ask, bid, observed } = validatedQuote(quote, now)
    return { ask, bid, observed }
  })
  const bid = Math.round(Math.max(0, parsed[0]!.bid - parsed[1]!.ask) * 1e8) / 1e8
  const ask = Math.round((parsed[0]!.ask - parsed[1]!.bid) * 1e8) / 1e8
  if (ask <= 0 || bid > ask) throw new OrderMarketError('OrderMarketQuote:invalid-spread-market')
  const instrument = exactlyOneRecord(instrumentPayload, 'OrderMarketInstrument')
  if (jsonText(instrument.symbol)?.toUpperCase() !== action.underlying) throw new OrderMarketError('OrderMarketInstrument:mismatch')
  const tickSize = tickSizeAt(instrument['option-tick-sizes'], action.limitPrice, 'option')
  if (!isTickAligned(action.limitPrice, tickSize)) throw offTick(tickSize)
  if (action.limitPrice < bid || action.limitPrice > ask) {
    throw outsideQuote(bid, ask)
  }
  return {
    ask,
    bid,
    observedAt: new Date(Math.min(parsed[0]!.observed, parsed[1]!.observed)).toISOString(),
    tickSize,
  }
}

export async function assertOrderMarketSafe(
  env: AppEnv,
  action: OrderAction,
  resolvedOptions: readonly EquityOptionContract[] = [],
  now = new Date(),
): Promise<OrderMarket> {
  if (action.kind === 'place_vertical_spread_order') {
    if (resolvedOptions.length !== 2) throw new OrderMarketError('OrderMarket:missing-spread-contracts')
    const query = resolvedOptions.map((contract) => `equity-option=${encodeURIComponent(contract.symbol)}`).join('&')
    const [quotePayload, instrumentPayload] = await Promise.all([
      brokerApi().tastyRequest(env, `/market-data/by-type?${query}`),
      brokerApi().tastyRequest(env, `/instruments/equities/${encodeURIComponent(action.underlying)}`),
    ])
    return spreadOrderMarketFromPayloads(action, quotePayload, instrumentPayload, resolvedOptions, now)
  }
  const resolvedOption = resolvedOptions[0]
  const brokerSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!brokerSymbol) throw new OrderMarketError('OrderMarket:missing-contract')
  const quoteQuery = action.kind === 'place_option_order'
    ? `equity-option=${encodeURIComponent(brokerSymbol)}`
    : `equity=${encodeURIComponent(brokerSymbol)}`
  const instrumentSymbol = action.kind === 'place_option_order' ? action.underlying : action.symbol
  const [quotePayload, instrumentPayload] = await Promise.all([
    brokerApi().tastyRequest(env, `/market-data/by-type?${quoteQuery}`),
    brokerApi().tastyRequest(env, `/instruments/equities/${encodeURIComponent(instrumentSymbol)}`),
  ])
  return orderMarketFromPayloads(action, quotePayload, instrumentPayload, resolvedOption, now)
}
