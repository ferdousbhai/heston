import { type OrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import { type EquityOptionContract } from './option-contract'
import { tastyRequest } from './tastytrade'

type JsonRecord = Record<string, unknown>
type OrderAction = OrderPlacement

export type OrderMarket = {
  ask: number
  bid: number
  observedAt: string
  tickSize: number
}

function record(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : undefined
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function exactlyOneRecord(payload: unknown, label: string): JsonRecord {
  const body = record(payload)
  const rawData = body?.data ?? payload
  const data = record(rawData)
  const rows = Array.isArray(rawData)
    ? rawData
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(body?.items)
        ? body.items
        : data ? [data] : undefined
  if (!rows || rows.length !== 1) throw new Error(`${label}:invalid-response`)
  const row = record(rows[0])
  if (!row) throw new Error(`${label}:invalid-response`)
  return row
}

function tickSizeAt(rules: unknown, price: number): number {
  if (!Array.isArray(rules) || !rules.length) throw new Error('OrderMarket:missing-tick-rules')
  const parsed = rules.map((value) => {
    const row = record(value)
    const tick = finiteNumber(row?.value)
    const rawThreshold = row?.threshold
    const threshold = rawThreshold === undefined || rawThreshold === null ? undefined : finiteNumber(rawThreshold)
    if (!row || tick === undefined || tick <= 0
      || (rawThreshold !== undefined && rawThreshold !== null && threshold === undefined)) {
      throw new Error('OrderMarket:invalid-tick-rules')
    }
    return { tick, threshold }
  })
  const thresholdMatches = parsed.filter((rule) => rule.threshold !== undefined && price >= rule.threshold)
  if (thresholdMatches.length) {
    return thresholdMatches.sort((left, right) => right.threshold! - left.threshold!)[0]!.tick
  }
  const base = parsed.filter((rule) => rule.threshold === undefined)
  if (base.length !== 1) throw new Error('OrderMarket:ambiguous-tick-rules')
  return base[0]!.tick
}

function isTickAligned(price: number, tickSize: number): boolean {
  const units = price / tickSize
  return Math.abs(units - Math.round(units)) <= 1e-7
}

export function orderMarketFromPayloads(
  action: OrderAction,
  quotePayload: unknown,
  instrumentPayload: unknown,
  resolvedOption: EquityOptionContract | undefined,
  now = new Date(),
): OrderMarket {
  const expectedSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!expectedSymbol) throw new Error('OrderMarket:missing-contract')
  const expectedType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const quote = exactlyOneRecord(quotePayload, 'OrderMarketQuote')
  const responseSymbol = text(quote.symbol)
  const responseType = text(quote['instrument-type'] ?? quote.instrumentType)
  const bid = finiteNumber(quote.bid)
  const ask = finiteNumber(quote.ask)
  const rawObservedAt = text(quote['updated-at'] ?? quote.updatedAt)
  const observedTime = Date.parse(rawObservedAt ?? '')
  if (responseSymbol !== expectedSymbol || responseType !== expectedType
    || bid === undefined || ask === undefined || bid < 0 || ask <= 0 || bid > ask
    || !Number.isFinite(observedTime) || observedTime > now.getTime() + 60_000
    || now.getTime() - observedTime > 15 * 60_000) {
    throw new Error('OrderMarketQuote:invalid-or-stale')
  }

  const instrument = exactlyOneRecord(instrumentPayload, 'OrderMarketInstrument')
  if (text(instrument.symbol)?.toUpperCase() !== (action.kind === 'place_option_order' ? action.underlying : action.symbol)) {
    throw new Error('OrderMarketInstrument:mismatch')
  }
  const tickSize = tickSizeAt(
    action.kind === 'place_option_order' ? instrument['option-tick-sizes'] : instrument['tick-sizes'],
    action.limitPrice,
  )
  if (!isTickAligned(action.limitPrice, tickSize)) throw new Error(`OrderMarket:limit-must-use-${tickSize}-tick`)
  if (action.limitPrice < bid || action.limitPrice > ask) {
    throw new Error(`OrderMarket:limit-outside-${bid.toFixed(2)}-${ask.toFixed(2)}`)
  }
  return { ask, bid, observedAt: new Date(observedTime).toISOString(), tickSize }
}

export async function assertOrderMarketSafe(
  env: AppEnv,
  action: OrderAction,
  resolvedOption?: EquityOptionContract,
  now = new Date(),
): Promise<OrderMarket> {
  const brokerSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!brokerSymbol) throw new Error('OrderMarket:missing-contract')
  const quoteQuery = action.kind === 'place_option_order'
    ? `equity-option=${encodeURIComponent(brokerSymbol)}`
    : `equity=${encodeURIComponent(brokerSymbol)}`
  const instrumentSymbol = action.kind === 'place_option_order' ? action.underlying : action.symbol
  const [quotePayload, instrumentPayload] = await Promise.all([
    tastyRequest(env, `/market-data/by-type?${quoteQuery}`),
    tastyRequest(env, `/instruments/equities/${encodeURIComponent(instrumentSymbol)}`),
  ])
  return orderMarketFromPayloads(action, quotePayload, instrumentPayload, resolvedOption, now)
}

export function orderMarketPreview(market: OrderMarket): string {
  return `Market $${market.bid.toFixed(2)}–$${market.ask.toFixed(2)} · $${market.tickSize.toFixed(2)} tick`
}
