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

type OrderAction = FreshOrderPlacement

export type OrderMarket = {
  ask: number
  bid: number
  observedAt: string
  tickSize: number
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
  if (!rows?.length) throw new Error(`${label}:invalid-response`)
  return rows.map((value) => {
    const row = jsonObject(value)
    if (!row) throw new Error(`${label}:invalid-response`)
    return row
  })
}

function exactlyOneRecord(payload: JsonValue, label: string): JsonObject {
  const rows = recordRows(payload, label)
  if (rows.length !== 1) throw new Error(`${label}:invalid-response`)
  return rows[0]!
}

function tickSizeAt(rules: JsonValue, price: number, kind: 'equity' | 'option'): number {
  let parsed
  try {
    parsed = tastytradeTickSizes(rules, 'OrderMarket')
  } catch {
    throw new Error('OrderMarket:invalid-tick-rules')
  }
  if (!parsed.length) throw new Error('OrderMarket:missing-tick-rules')

  const unbounded = parsed.filter((rule) => rule.threshold === null)
  const bounded = parsed
    .filter((rule): rule is typeof rule & { threshold: number } => rule.threshold !== null)
    .sort((left, right) => left.threshold - right.threshold)
  const uniqueThresholds = new Set(bounded.map((rule) => rule.threshold))
  if (unbounded.length > 1 || uniqueThresholds.size !== bounded.length) {
    throw new Error('OrderMarket:ambiguous-tick-rules')
  }

  if (kind === 'equity') {
    // Equity tiers are finite lower floors. Some responses contain only the
    // $1-and-up rule, so prices below the first floor fail closed without a base.
    const match = [...bounded].reverse().find((rule) => price >= rule.threshold)
    if (match) return match.value
    if (unbounded.length === 1) return unbounded[0]!.value
    throw new Error('OrderMarket:ambiguous-tick-rules')
  }

  // tastytrade thresholds are exclusive upper cutoffs. The unbounded tier
  // applies at the cutoff and above (for example, .05 below $3 and .10 at $3).
  if (unbounded.length !== 1) throw new Error('OrderMarket:ambiguous-tick-rules')
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
  if (action.kind === 'place_vertical_spread_order') throw new Error('OrderMarket:use-spread-market')
  const expectedSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!expectedSymbol) throw new Error('OrderMarket:missing-contract')
  const expectedType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const quote = exactlyOneRecord(quotePayload, 'OrderMarketQuote')
  const responseSymbol = jsonText(quote.symbol)
  const responseType = jsonText(quote['instrument-type'] ?? quote.instrumentType)
  const bid = jsonNumber(quote.bid)
  const ask = jsonNumber(quote.ask)
  const rawObservedAt = jsonText(quote['updated-at'] ?? quote.updatedAt)
  const observedTime = Date.parse(rawObservedAt ?? '')
  if (responseSymbol !== expectedSymbol || responseType !== expectedType
    || bid === undefined || ask === undefined || bid < 0 || ask <= 0 || bid > ask
    || !Number.isFinite(observedTime) || observedTime > now.getTime() + 60_000
    || now.getTime() - observedTime > 15 * 60_000) {
    throw new Error('OrderMarketQuote:invalid-or-stale')
  }

  const instrument = exactlyOneRecord(instrumentPayload, 'OrderMarketInstrument')
  if (jsonText(instrument.symbol)?.toUpperCase() !== (action.kind === 'place_option_order' ? action.underlying : action.symbol)) {
    throw new Error('OrderMarketInstrument:mismatch')
  }
  const tickSize = tickSizeAt(
    action.kind === 'place_option_order' ? instrument['option-tick-sizes'] : instrument['tick-sizes'],
    action.limitPrice,
    action.kind === 'place_option_order' ? 'option' : 'equity',
  )
  if (!isTickAligned(action.limitPrice, tickSize)) throw new Error(`OrderMarket:limit-must-use-${tickSize}-tick`)
  if (action.limitPrice < bid || action.limitPrice > ask) {
    throw new Error(`OrderMarket:limit-outside-${bid.toFixed(2)}-${ask.toFixed(2)}`)
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
  if (resolvedOptions.length !== 2) throw new Error('OrderMarket:missing-spread-contracts')
  const quotes = recordRows(quotePayload, 'OrderMarketQuote')
  if (quotes.length !== 2) throw new Error('OrderMarketQuote:invalid-response')
  const bySymbol = new Map(quotes.map((quote) => [jsonText(quote.symbol), quote]))
  const parsed = resolvedOptions.map((contract) => {
    const quote = bySymbol.get(contract.symbol)
    const bid = jsonNumber(quote?.bid)
    const ask = jsonNumber(quote?.ask)
    const observed = Date.parse(jsonText(quote?.['updated-at'] ?? quote?.updatedAt) ?? '')
    if (!quote
      || jsonText(quote['instrument-type'] ?? quote.instrumentType) !== 'Equity Option'
      || bid === undefined || ask === undefined || bid < 0 || ask <= 0 || bid > ask
      || !Number.isFinite(observed) || observed > now.getTime() + 60_000
      || now.getTime() - observed > 15 * 60_000) {
      throw new Error('OrderMarketQuote:invalid-or-stale')
    }
    return { ask, bid, observed }
  })
  const bid = Math.round(Math.max(0, parsed[0]!.bid - parsed[1]!.ask) * 1e8) / 1e8
  const ask = Math.round((parsed[0]!.ask - parsed[1]!.bid) * 1e8) / 1e8
  if (ask <= 0 || bid > ask) throw new Error('OrderMarketQuote:invalid-spread-market')
  const instrument = exactlyOneRecord(instrumentPayload, 'OrderMarketInstrument')
  if (jsonText(instrument.symbol)?.toUpperCase() !== action.underlying) throw new Error('OrderMarketInstrument:mismatch')
  const tickSize = tickSizeAt(instrument['option-tick-sizes'], action.limitPrice, 'option')
  if (!isTickAligned(action.limitPrice, tickSize)) throw new Error(`OrderMarket:limit-must-use-${tickSize}-tick`)
  if (action.limitPrice < bid || action.limitPrice > ask) {
    throw new Error(`OrderMarket:limit-outside-${bid.toFixed(2)}-${ask.toFixed(2)}`)
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
    if (resolvedOptions.length !== 2) throw new Error('OrderMarket:missing-spread-contracts')
    const query = resolvedOptions.map((contract) => `equity-option=${encodeURIComponent(contract.symbol)}`).join('&')
    const [quotePayload, instrumentPayload] = await Promise.all([
      brokerApi().tastyRequest(env, `/market-data/by-type?${query}`),
      brokerApi().tastyRequest(env, `/instruments/equities/${encodeURIComponent(action.underlying)}`),
    ])
    return spreadOrderMarketFromPayloads(action, quotePayload, instrumentPayload, resolvedOptions, now)
  }
  const resolvedOption = resolvedOptions[0]
  const brokerSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!brokerSymbol) throw new Error('OrderMarket:missing-contract')
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

export function orderMarketPreview(market: OrderMarket): string {
  return `Market $${market.bid.toFixed(2)}-$${market.ask.toFixed(2)} · $${market.tickSize.toFixed(2)} tick`
}
