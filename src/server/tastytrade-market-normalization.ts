import { z } from 'zod'

import { EquitySymbolSchema, type InstrumentCatalogItem } from '../domain/instrument'
import { isValidIsoDate } from '../domain/iso-date'
import {
  type MarketSnapshot,
  type Ticker,
} from '../domain/market'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import {
  envelopeRows,
  jsonNumber,
  JsonObjectArraySchema,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { earningsDateFromMetric } from './catalysts'
import {
  type TastytradeMarketMetricRecord,
  type TastytradeMarketQuoteRecord,
} from './tastytrade-market-store'

function numeric(value: JsonValue, field: string): number {
  const parsed = jsonNumber(value)
  if (parsed === undefined) throw new Error(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

// tastytrade uses both omission and JSON null for an optional observation that
// it did not report. Neither form asserts a value; every other value is parsed.
function unreported(value: JsonValue): value is null | undefined {
  return value === undefined || value === null
}

function optionalNumeric(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return numeric(value, field)
}

function nonnegative(value: JsonValue, field: string): number {
  const parsed = numeric(value, field)
  if (parsed < 0) throw new Error(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

function optionalNonnegative(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return nonnegative(value, field)
}

function positive(value: JsonValue, field: string): number {
  const parsed = numeric(value, field)
  if (parsed <= 0) throw new Error(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

function optionalPositive(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return positive(value, field)
}

function optionalText(value: JsonValue, field: string): string | undefined {
  if (unreported(value)) return undefined
  const parsed = jsonText(value)
  if (!parsed) throw new Error(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

function optionalBoolean(value: JsonValue, field: string): boolean | undefined {
  if (unreported(value)) return undefined
  const parsed = z.boolean().safeParse(value)
  if (!parsed.success) throw new Error(`TastytradeSnapshot:invalid-${field}`)
  return parsed.data
}

/*
 * tastytrade market metrics mix two units, established from production D1 rows
 * rather than documentation: `implied-volatility-index`, its rank, percentile,
 * 5-day change, and per-expiration IVs are decimal ratios (0.261 = 26.1%), while
 * `historical-volatility-30-day` (30.8), `iv-hv-30-day-difference` (-4.7), and the
 * annual `borrow-rate` (1.5 for Easy To Borrow, 951.15 for PCLA Locate Required) are
 * already percentage points. Multiplying those by 100 rejected or distorted real
 * observations, so the `*Points` helpers below keep them as reported.
 */
function percentagePoints(value: JsonValue, field: string): number {
  return numeric(value, field) * 100
}

function optionalPercentagePoints(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return percentagePoints(value, field)
}

function reportedEarningsDate(metrics: JsonObject): string | null {
  const value = metrics.earnings
  if (unreported(value)) return null
  const earnings = jsonObject(value)
  if (!earnings) throw new Error('TastytradeSnapshot:invalid-earnings')
  const rawDate = earnings['expected-report-date']
  if (unreported(rawDate)) return null
  const date = optionalText(rawDate, 'earnings-date')
  if (!date || !isValidIsoDate(date)) throw new Error('TastytradeSnapshot:invalid-earnings-date')
  return date
}

function optionTermStructure(metrics: JsonObject, symbol: string): Ticker['ivTermStructure'] {
  const value = metrics['option-expiration-implied-volatilities'] ?? metrics.optionExpirationImpliedVolatilities
  if (unreported(value)) return undefined
  if (!Array.isArray(value)) throw new Error(`TastytradeSnapshot:invalid-option-term-structure:${symbol}`)
  const candidates = value.flatMap((candidate) => {
    const row = jsonObject(candidate)
    if (!row) throw new Error(`TastytradeSnapshot:invalid-option-term-row:${symbol}`)
    const rawExpiration = optionalText(
      row['expiration-date'] ?? row.expirationDate,
      `option-expiration:${symbol}`,
    )
    const impliedVolatility = optionalPercentagePoints(
      row['implied-volatility'] ?? row.impliedVolatility,
      `option-implied-volatility:${symbol}`,
    )
    const chainType = optionalText(
      row['option-chain-type'] ?? row.optionChainType,
      `option-chain-type:${symbol}`,
    ) ?? ''
    // Incomplete optional rows assert no term observation; malformed reported
    // fields still fail in the parsers above.
    if (rawExpiration === undefined || impliedVolatility === undefined) return []
    const expiration = rawExpiration.slice(0, 10)
    if (!isValidIsoDate(expiration)) throw new Error(`TastytradeSnapshot:invalid-option-expiration:${symbol}`)
    if (impliedVolatility < 0) throw new Error(`TastytradeSnapshot:invalid-option-implied-volatility:${symbol}`)
    return [{
      chainType,
      expiration,
      impliedVolatility,
    }]
  }).sort((left, right) => left.expiration.localeCompare(right.expiration)
    || Number(right.chainType === 'Standard') - Number(left.chainType === 'Standard')
    || left.chainType.localeCompare(right.chainType))
  const distinct = [...new Map(candidates.map((candidate) => [candidate.expiration, candidate])).values()]
  const [front, back] = distinct
  return front && back ? {
    backExpiration: back.expiration,
    backIv: back.impliedVolatility,
    frontExpiration: front.expiration,
    frontIv: front.impliedVolatility,
  } : undefined
}

function assetType(instrument: JsonObject | undefined): Ticker['assetType'] {
  if (!instrument) return undefined
  const isIndex = optionalBoolean(instrument['is-index'] ?? instrument.isIndex, 'is-index')
  const isEtf = optionalBoolean(instrument['is-etf'] ?? instrument.isEtf, 'is-etf')
  if (isIndex && isEtf) throw new Error('TastytradeSnapshot:conflicting-asset-type')
  if (isIndex) return 'index'
  if (isEtf) return 'etf'
  return isIndex === false && isEtf === false ? 'stock' : undefined
}

export function equityCandleFromTime(payload: JsonValue, now = Date.now()): number {
  const body = jsonObject(payload)
  const session = jsonObject(body?.data ?? payload)
  if (!session) throw new Error('TastytradeCandleSession:invalid-response')
  const currentOpen = sessionOpenTime(session['open-at'], 'current')
  if (currentOpen !== undefined && currentOpen <= now) return currentOpen
  const previous = jsonObject(session['previous-session'])
  if (!previous) throw new Error('TastytradeCandleSession:invalid-previous-session')
  const previousOpen = sessionOpenTime(previous['open-at'], 'previous')
  if (previousOpen !== undefined && previousOpen <= now) return previousOpen
  throw new Error('TastytradeCandleSession:no-open-session')
}

function sessionOpenTime(value: JsonValue, session: 'current' | 'previous'): number | undefined {
  if (unreported(value)) return undefined
  const openTime = Date.parse(jsonText(value) ?? '')
  if (!Number.isFinite(openTime)) {
    throw new Error(`TastytradeCandleSession:invalid-${session}-open`)
  }
  return openTime
}

export function strictTastytradeRows(payload: JsonValue, label: string): JsonObject[] {
  const candidate = envelopeRows(payload)
  const rows = candidate && JsonObjectArraySchema.safeParse(candidate).data
  if (!rows) throw new Error(`${label}:invalid-response`)
  return rows
}

export function tastytradeRowsByRequestedSymbol(
  rows: readonly JsonObject[],
  requestedSymbols: readonly string[],
  label: string,
): Map<string, JsonObject> {
  const requested = new Set(requestedSymbols)
  const bySymbol = new Map<string, JsonObject>()
  for (const row of rows) {
    const parsed = EquitySymbolSchema.safeParse(jsonText(row.symbol))
    if (!parsed.success) throw new Error(`${label}:invalid-symbol`)
    const symbol = parsed.data
    if (!requested.has(symbol)) throw new Error(`${label}:unexpected-symbol`)
    if (bySymbol.has(symbol)) throw new Error(`${label}:duplicate-symbol`)
    bySymbol.set(symbol, row)
  }
  if (bySymbol.size !== requested.size) throw new Error(`${label}:missing-symbol`)
  return bySymbol
}

export type NormalizedTastytradeMarketTicker = {
  metricRecord: TastytradeMarketMetricRecord
  quoteRecord: TastytradeMarketQuoteRecord
  ticker: Ticker
}

export function normalizeTastytradeMarketTicker(
  symbol: string,
  metrics: JsonObject | undefined,
  quote: JsonObject | undefined,
  position: boolean,
  instrument?: JsonObject,
): NormalizedTastytradeMarketTicker {
  if (!metrics) throw new Error(`TastytradeSnapshot:missing-metrics:${symbol}`)
  if (!quote) throw new Error(`TastytradeSnapshot:missing-quote:${symbol}`)
  const price = positive(quote.mark ?? quote['mark-price'] ?? quote.last ?? quote['last-price'] ?? quote.close, 'price')
  const previousClose = positive(
    quote.prevClose
      ?? quote['prev-close']
      ?? quote.previousClose
      ?? quote['previous-close']
      ?? quote.prevDayClose
      ?? quote['prev-day-close'],
    'previous-close',
  )
  // tastytrade reports mark and previous close, not day-change fields. Day move
  // is therefore a read-model projection, never a synthesized source record.
  const change = price - previousClose
  const changePercent = (change / previousClose) * 100
  const ivIndex = optionalPercentagePoints(
    metrics['implied-volatility-index'],
    `implied-volatility-index:${symbol}`,
  )
  const ivRank = optionalPercentagePoints(
    metrics['implied-volatility-index-rank'] ?? metrics['implied-volatility-rank'],
    `implied-volatility-rank:${symbol}`,
  )
  const ivPercentile = optionalPercentagePoints(
    metrics['implied-volatility-percentile'],
    `implied-volatility-percentile:${symbol}`,
  )
  const liquidity = optionalNumeric(metrics['liquidity-rating'], `liquidity-rating:${symbol}`)
  const marketCap = optionalNonnegative(metrics['market-cap'] ?? metrics.marketCap, 'market-cap')
  const volume = optionalNonnegative(quote.volume ?? quote['day-volume'], 'volume')
  const yearLow = optionalPositive(quote.yearLowPrice ?? quote['year-low-price'], 'year-low')
  const yearHigh = optionalPositive(quote.yearHighPrice ?? quote['year-high-price'], 'year-high')
  if (yearLow !== undefined && yearHigh !== undefined && yearHigh <= yearLow) {
    throw new Error('TastytradeSnapshot:invalid-year-range')
  }
  const quoteUpdatedAt = optionalText(quote.updatedAt ?? quote['updated-at'], 'updated-at')
  const quoteTime = Date.parse(quoteUpdatedAt ?? '')
  if (!Number.isFinite(quoteTime)) throw new Error('TastytradeSnapshot:invalid-updated-at')
  const updatedAt = new Date(quoteTime).toISOString()
  const lendability = optionalText(metrics.lendability ?? instrument?.lendability, 'lendability')
  const ivIndex5DayChange = optionalPercentagePoints(
    metrics['implied-volatility-index-5-day-change'] ?? metrics.impliedVolatilityIndex5DayChange,
    'implied-volatility-index-5-day-change',
  )
  const historicalVolatility30Day = optionalNonnegative(
    metrics['historical-volatility-30-day'] ?? metrics.historicalVolatility30Day,
    'historical-volatility-30-day',
  )
  const ivHistoricalVolatility30DayDifference = optionalNumeric(
    metrics['iv-hv-30-day-difference'] ?? metrics.ivHv30DayDifference,
    'iv-hv-30-day-difference',
  )
  const ivTermStructure = optionTermStructure(metrics, symbol)
  const earningsDate = earningsDateFromMetric(metrics)
  const metricRecord: TastytradeMarketMetricRecord = {
    earningsDate: reportedEarningsDate(metrics),
    historicalVolatility30Day,
    ivHistoricalVolatility30DayDifference,
    ivIndex,
    ivIndex5DayChange,
    ivPercentile,
    ivRank,
    ivTermStructure,
    liquidity,
    marketCap,
    symbol,
  }
  const quoteRecord: TastytradeMarketQuoteRecord = {
    previousClose,
    price,
    providerUpdatedAt: updatedAt,
    symbol,
    volume,
    yearHigh,
    yearLow,
  }
  return { metricRecord, quoteRecord, ticker: {
    symbol,
    name: optionalText(
      instrument?.description ?? instrument?.['short-description'] ?? quote.description,
      'instrument-name',
    ) ?? symbol,
    assetType: assetType(instrument),
    lendability,
    marketCap,
    price,
    change,
    changePercent,
    sparkline: [],
    ivRank,
    ivPercentile,
    ivIndex,
    ivIndex5DayChange,
    historicalVolatility30Day,
    ivHistoricalVolatility30DayDifference,
    ivTermStructure,
    liquidity,
    volume,
    yearHigh,
    yearLow,
    earningsDate,
    position,
    updatedAt,
  } }
}

export function liveTickerFromRecords(
  symbol: string,
  metrics: JsonObject | undefined,
  quote: JsonObject | undefined,
  position: boolean,
  instrument?: JsonObject,
): Ticker {
  return normalizeTastytradeMarketTicker(symbol, metrics, quote, position, instrument).ticker
}

export function catalogTickerInstrument(item: InstrumentCatalogItem | undefined): JsonObject | undefined {
  if (!item) return undefined
  return {
    description: item.description,
    'is-etf': item.isEtf,
    'is-index': item.isIndex,
    lendability: item.lendability,
    'short-description': item.shortDescription,
  }
}

export function marketStateFromTastytradeSession(payload: JsonValue): MarketSnapshot['marketState'] {
  const body = jsonObject(payload)
  const session = jsonObject(body?.data ?? payload)
  if (!session) throw new Error('TastytradeMarketSession:invalid-response')
  const rawState = optionalText(session.state, 'market-state')?.toLowerCase()
  if (!rawState) throw new Error('TastytradeMarketSession:missing-state')
  if (rawState === 'open') return 'open'
  if (rawState.includes('pre')) return 'pre'
  if (rawState.includes('after') || rawState.includes('extended')) return 'after'
  if (rawState === 'closed') return 'closed'
  return 'unknown'
}

export function selectSnapshotSymbols(
  positionSymbols: readonly string[],
  requestedSymbols: readonly string[],
  internalWatchlistSymbols: readonly string[],
): string[] {
  const symbols = [...new Set([
    ...requestedSymbols,
    ...positionSymbols,
    ...internalWatchlistSymbols,
  ].map((symbol) => EquitySymbolSchema.parse(symbol)))]
  if (symbols.length > MAX_WATCHLIST_SYMBOLS) throw new Error('TastytradeSnapshot:too-many-symbols')
  return symbols
}

export function activeEquityPositionSymbols(positions: readonly JsonObject[]): string[] {
  const symbols = positions.flatMap((position) => {
    const quantity = numeric(position.quantity, 'position-quantity')
    if (quantity === 0) return []
    const rawSymbol = jsonText(position['underlying-symbol']) ?? jsonText(position.symbol)
    const parsed = EquitySymbolSchema.safeParse(rawSymbol)
    if (!parsed.success) throw new Error('TastytradePositions:invalid-symbol')
    return [parsed.data]
  })
  return [...new Set(symbols)]
}
