import { z } from 'zod'

import { isValidIsoDate } from '../domain/catalyst'
import { EquitySymbolSchema, type InstrumentCatalogItem } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import {
  MarketSnapshotSchema,
  parseStoredResearchBrief,
  type MarketSnapshot,
  type Ticker,
  type Watchlist,
} from '../domain/market'
import { type AppEnv } from './env'
import { readBoundedJson } from './bounded-response'
import { catalystsFromMarketMetrics, earningsDateFromMetric, persistAndLoadCatalysts } from './catalysts'
import {
  ensureInternalWatchlistSeeded,
  previewInternalWatchlistSeed,
  pruneInternalWatchlistToFocus,
  readInternalWatchlist,
  readInternalWatchlistCatalogCandidates,
  type InternalWatchlistSeedPayloads,
  type InternalWatchlistSeedPreview,
} from './internal-watchlist'
import {
  envelopeRows,
  jsonNumber,
  JsonObjectArraySchema,
  jsonObject,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { readStoredSecret } from './secrets'
import {
  missingInstrumentCatalogSymbols,
  loadInstrumentCatalog,
  persistInstrumentCatalog,
  readInstrumentCatalog,
  type InstrumentCatalogRefresh,
  unresolvedInstrumentCatalogItem,
} from './instrument-catalog'
import { tastytradeApiVersion } from './tastytrade-version'
import {
  persistTastytradeMarketSnapshot,
  type TastytradeMarketMetricRecord,
  type TastytradeMarketQuoteRecord,
} from './tastytrade-market-store'
import { defineSeam, type SeamValue } from './seam'
import { loadStoredPublicMarketUniverse, publishInternalWatchlistUniverse } from './public-market-universe'

const USER_AGENT = 'Spice/0.1'
// Provider JSON is buffered for strict parsing; stay within the Worker isolate memory budget
// while allowing the catalog endpoints, which are substantially larger than normal reads.
const MAX_TASTYTRADE_RESPONSE_BYTES = 16 * 1024 * 1024
let cachedAccess: { expiresAt: number; token: string } | undefined

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

function apiBase(env: AppEnv) {
  return env.TASTYTRADE_API_BASE || 'https://api.tastyworks.com'
}

async function refreshAccessToken(env: AppEnv): Promise<string> {
  const [clientSecret, refreshToken] = await Promise.all([
    readStoredSecret(env.TASTYTRADE_CLIENT_SECRET, 'TASTYTRADE_CLIENT_SECRET'),
    readStoredSecret(env.TASTYTRADE_REFRESH_TOKEN, 'TASTYTRADE_REFRESH_TOKEN'),
  ])
  const response = await fetch(`${apiBase(env)}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`TastytradeAuth:${response.status}`)
  }
  const payload = jsonObjectOrEmpty(await readBoundedJson(response, 256_000, 'TastytradeAuth'))
  const token = jsonText(payload.access_token)
  if (!token) throw new Error('TastytradeAuth:missing-token')
  const lifetimeSeconds = jsonNumber(payload.expires_in)
  if (lifetimeSeconds === undefined || !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new Error('TastytradeAuth:invalid-token-lifetime')
  }
  const lifetimeMs = lifetimeSeconds * 1_000
  const skewMs = Math.min(30_000, lifetimeMs * 0.1)
  cachedAccess = { token, expiresAt: Date.now() + lifetimeMs - skewMs }
  return token
}

async function accessToken(env: AppEnv): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.token
  // A fulfilled token is plain scalar cache data. A pending fetch Promise is a
  // request-context I/O object and must never be shared through Worker globals.
  return refreshAccessToken(env)
}

function safeEndpoint(path: string): string {
  return path.split('?')[0]!.replace(/\/accounts\/[^/]+/g, '/accounts/[redacted]')
}

type BrokerRequestGate = ReturnType<NonNullable<AppEnv['BROKER_GATE']>['getByName']>

export type BrokerMutationLease = {
  renew(): Promise<void>
}

function requestGate(env: AppEnv): BrokerRequestGate {
  // Broker coordination is part of the provider safety boundary. Validate the
  // binding before reading credentials so a misbound deployment cannot silently
  // bypass request throttling.
  const namespace = env.BROKER_GATE
  if (!namespace) throw new Error('TastytradeCoordinatorUnavailable')
  return namespace.getByName('primary-account')
}

/**
 * Serialize one broker read-modify-write sequence across Worker isolates. Renewals
 * are explicit so callers can prove the durable lease is still theirs immediately
 * before each broker mutation. A failed cleanup must not obscure an accepted or
 * ambiguous broker result; the persisted lease expires on its own as a backstop.
 */
export async function withBrokerMutationLease<T>(
  env: AppEnv,
  operation: (lease: BrokerMutationLease) => Promise<T>,
): Promise<T> {
  const gate = requestGate(env)
  const token = await gate.acquireMutation()
  try {
    return await operation({ renew: () => gate.renewMutation(token) })
  } finally {
    try {
      await gate.releaseMutation(token)
    } catch {
      console.error('BrokerMutationLeaseReleaseFailed')
    }
  }
}

async function authorizedRequest(
  env: AppEnv,
  path: string,
  init: RequestInit,
  token: string,
  gate: BrokerRequestGate,
): Promise<Response> {
  await gate.acquire()
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  const apiVersion = tastytradeApiVersion(path)
  if (apiVersion && !headers.has('Accept-Version')) headers.set('Accept-Version', apiVersion)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('User-Agent', USER_AGENT)
  if (init.body) headers.set('Content-Type', 'application/json')
  const timeout = AbortSignal.timeout(20_000)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(`${apiBase(env)}${path}`, { ...init, headers, signal })
}

export async function tastyRequest(
  env: AppEnv,
  path: string,
  init: RequestInit = {},
): Promise<JsonValue> {
  const gate = requestGate(env)
  let token = await accessToken(env)
  let response = await authorizedRequest(env, path, init, token, gate)
  const method = (init.method ?? 'GET').toUpperCase()
  if (response.status === 401 && (method === 'GET' || method === 'HEAD')) {
    if (cachedAccess?.token === token) cachedAccess = undefined
    token = await accessToken(env)
    response = await authorizedRequest(env, path, init, token, gate)
  }
  if (!response.ok) {
    await response.body?.cancel()
    const error = new Error(`TastytradeApi:${response.status}:${safeEndpoint(path)}`)
    error.name = response.status >= 500 || response.status === 408
      ? 'TastytradeApiAmbiguousError'
      : 'TastytradeApiError'
    throw error
  }
  if (response.status === 204) return {}
  // The label carries the redacted endpoint so an oversized or malformed body names the
  // same request the status error above would have named.
  return readBoundedJson(response, MAX_TASTYTRADE_RESPONSE_BYTES, `TastytradeApi:${safeEndpoint(path)}`)
}

async function resolveAccountNumber(env: AppEnv): Promise<string> {
  const payload = await tastyRequest(env, '/customers/me/accounts')
  const accounts = envelopeRows(payload)
  if (!accounts) throw new Error('TastytradeAccount:invalid-accounts')
  if (accounts.length !== 1) throw new Error('TastytradeAccount:explicit-account-required')
  const row = jsonObject(accounts[0])
  if (!row) throw new Error('TastytradeAccount:invalid-account')
  const account = jsonObject(row.account ?? row)
  if (!account) throw new Error('TastytradeAccount:invalid-account')
  const accountNumber = jsonText(account['account-number'])
  if (!accountNumber) throw new Error('TastytradeAccount:not-found')
  return accountNumber
}

async function loadQuoteToken(env: AppEnv): Promise<{ token: string; url: string }> {
  const payload = jsonObjectOrEmpty(await tastyRequest(env, '/api-quote-tokens'))
  const data = jsonObjectOrEmpty(payload.data ?? payload)
  const token = jsonText(data.token)
  const url = jsonText(data['dxlink-url'])
  if (!token || !url || !url.startsWith('wss://')) throw new Error('TastytradeQuoteToken:invalid')
  return { token, url }
}

export function equityCandleFromTime(payload: JsonValue, now = Date.now()): number {
  const body = jsonObject(payload)
  const session = jsonObject(body?.data ?? payload)
  if (!session) throw new Error('TastytradeCandleSession:invalid-response')
  const currentValue = session['open-at']
  const currentOpen = currentValue === undefined || currentValue === null
    ? undefined
    : Date.parse(jsonText(currentValue) ?? '')
  if (currentOpen !== undefined && !Number.isFinite(currentOpen)) {
    throw new Error('TastytradeCandleSession:invalid-current-open')
  }
  if (currentOpen !== undefined && currentOpen <= now) return currentOpen
  const previous = jsonObject(session['previous-session'])
  if (!previous) throw new Error('TastytradeCandleSession:invalid-previous-session')
  const previousValue = previous['open-at']
  const previousOpen = previousValue === undefined || previousValue === null
    ? undefined
    : Date.parse(jsonText(previousValue) ?? '')
  if (previousOpen !== undefined && !Number.isFinite(previousOpen)) {
    throw new Error('TastytradeCandleSession:invalid-previous-open')
  }
  if (previousOpen !== undefined && previousOpen <= now) return previousOpen
  throw new Error('TastytradeCandleSession:no-open-session')
}

async function loadEquityCandleFromTime(env: AppEnv): Promise<number> {
  return equityCandleFromTime(await tastyRequest(env, '/market-time/equities/sessions/current'))
}

function strictRows(payload: JsonValue, label: string): JsonObject[] {
  const candidate = envelopeRows(payload)
  const rows = candidate && JsonObjectArraySchema.safeParse(candidate).data
  if (!rows) throw new Error(`${label}:invalid-response`)
  return rows
}

function rowsByRequestedSymbol(
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

type NormalizedLiveTicker = {
  metricRecord: TastytradeMarketMetricRecord
  quoteRecord: TastytradeMarketQuoteRecord
  ticker: Ticker
}

function normalizeLiveTicker(
  symbol: string,
  metrics: JsonObject | undefined,
  quote: JsonObject | undefined,
  position: boolean,
  instrument?: JsonObject,
): NormalizedLiveTicker {
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
  const borrowRate = optionalNonnegative(
    metrics['borrow-rate'] ?? instrument?.['borrow-rate'] ?? instrument?.borrowRate,
    'borrow-rate',
  )
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
    borrowRate,
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
  return normalizeLiveTicker(symbol, metrics, quote, position, instrument).ticker
}

function catalogTickerInstrument(item: InstrumentCatalogItem | undefined): JsonObject | undefined {
  if (!item) return undefined
  return {
    'borrow-rate': item.borrowRate,
    description: item.description,
    'is-etf': item.isEtf,
    'is-index': item.isIndex,
    lendability: item.lendability,
    'short-description': item.shortDescription,
  }
}

const StoredResearchRowSchema = z.object({ payload_json: z.string() })

async function loadStoredResearch(env: AppEnv): Promise<MarketSnapshot['research']> {
  if (!env.DB) throw new Error('TastytradeResearch:store-unavailable')
  const result = await env.DB.prepare(
    'SELECT payload_json FROM research_briefs ORDER BY published_at DESC LIMIT 1',
  ).first<{ payload_json: string }>()
  if (!result) throw new Error('TastytradeResearch:not-found')
  const row = StoredResearchRowSchema.parse(result)
  return parseStoredResearchBrief(JSON.parse(row.payload_json))
}

type MarketSnapshotOptions = {
  symbols?: readonly string[]
}

function marketStateFromSession(payload: JsonValue): MarketSnapshot['marketState'] {
  const body = jsonObject(payload)
  const session = jsonObject(body?.data ?? payload)
  if (!session) throw new Error('TastytradeMarketSession:invalid-response')
  const rawState = optionalText(session.state, 'market-state')?.toLowerCase()
  if (!rawState) throw new Error('TastytradeMarketSession:missing-state')
  return rawState === 'open'
    ? 'open'
    : rawState.includes('pre') ? 'pre'
      : rawState.includes('after') || rawState.includes('extended') ? 'after'
        : rawState === 'closed' ? 'closed' : 'unknown'
}

async function loadMarketFacts(
  env: AppEnv,
  symbols: readonly string[],
  positionSymbols: ReadonlySet<string>,
): Promise<Pick<MarketSnapshot, 'catalysts' | 'tickers'>> {
  const metricQuery = symbols.map(encodeURIComponent).join(',')
  const marketDataQuery = symbols.map((symbol) => `equity=${encodeURIComponent(symbol)}`).join('&')
  const [[metricsPayload, marketDataPayload], instrumentCatalog] = await Promise.all([
    Promise.all([
      symbols.length ? tastyRequest(env, `/market-metrics?symbols=${metricQuery}`) : Promise.resolve([]),
      symbols.length ? tastyRequest(env, `/market-data/by-type?${marketDataQuery}`) : Promise.resolve([]),
    ]),
    readInstrumentCatalog(env, symbols),
  ])
  const metrics = strictRows(metricsPayload, 'TastytradeMetrics')
  const quotes = strictRows(marketDataPayload, 'TastytradeMarketData')
  const metricBySymbol = rowsByRequestedSymbol(metrics, symbols, 'TastytradeMetrics')
  const quoteBySymbol = rowsByRequestedSymbol(quotes, symbols, 'TastytradeMarketData')
  if (instrumentCatalog.size !== symbols.length) throw new Error('InstrumentCatalog:incomplete')
  const normalized = symbols.map((symbol) => normalizeLiveTicker(
      symbol,
      metricBySymbol.get(symbol),
      quoteBySymbol.get(symbol),
      positionSymbols.has(symbol),
      catalogTickerInstrument(instrumentCatalog.get(symbol)),
  ))
  const allCatalysts = await persistAndLoadCatalysts(
    env,
    catalystsFromMarketMetrics(metrics),
    symbols,
  )
  await persistTastytradeMarketSnapshot(env, {
    metrics: normalized.map((item) => item.metricRecord),
    quotes: normalized.map((item) => item.quoteRecord),
  })
  const allowedSymbols = new Set(symbols)
  return {
    tickers: normalized.map((item) => item.ticker),
    catalysts: allCatalysts.filter((catalyst) => allowedSymbols.has(catalyst.symbol)),
  }
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

function equityInstrumentPath(symbols: readonly string[]): string {
  const query = symbols.map((symbol) => `symbol[]=${encodeURIComponent(symbol)}`).join('&')
  return `/instruments/equities?per-page=${symbols.length}&${query}`
}

async function loadTastytradeInstrumentCatalog(
  env: AppEnv,
  symbols: readonly string[],
  now: Date,
) {
  return loadInstrumentCatalog(
    symbols,
    (chunk) => tastyRequest(env, equityInstrumentPath(chunk)),
    now,
  )
}

export async function refreshTastytradeInstrumentCatalog(
  env: AppEnv,
  symbols: readonly string[],
  now = new Date(),
): Promise<InstrumentCatalogRefresh> {
  const result = await loadTastytradeInstrumentCatalog(env, symbols, now)
  await persistInstrumentCatalog(env, [
    ...result.items,
    ...result.missingSymbols.map((symbol) => unresolvedInstrumentCatalogItem(symbol, now)),
  ])
  return {
    missingSymbols: result.missingSymbols,
    receivedCount: result.items.length,
    requestedCount: result.requestedCount,
  }
}

export async function refreshInternalInstrumentCatalogFromTastytrade(
  env: AppEnv,
  now = new Date(),
): Promise<InstrumentCatalogRefresh> {
  const symbols = (await readInternalWatchlist(env)).map((item) => item.symbol)
  return refreshTastytradeInstrumentCatalog(env, symbols, now)
}

export type InternalInstrumentCatalogChunkRefresh = InstrumentCatalogRefresh & {
  complete: boolean
  nextOffset: number
  totalCount: number
}

async function internalInstrumentCatalogChunk(
  env: AppEnv,
  offset: number,
  now: Date,
  persist: boolean,
): Promise<InternalInstrumentCatalogChunkRefresh> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('InstrumentCatalog:invalid-offset')
  const symbols = await readInternalWatchlistCatalogCandidates(env)
  if (offset > symbols.length) throw new Error('InstrumentCatalog:invalid-offset')
  const chunk = symbols.slice(offset, offset + MAX_WATCHLIST_SYMBOLS)
  const loaded = await loadTastytradeInstrumentCatalog(env, chunk, now)
  if (persist) {
    await persistInstrumentCatalog(env, [
      ...loaded.items,
      ...loaded.missingSymbols.map((symbol) => unresolvedInstrumentCatalogItem(symbol, now)),
    ])
  }
  const nextOffset = Math.min(symbols.length, offset + chunk.length)
  return {
    complete: nextOffset >= symbols.length,
    missingSymbols: loaded.missingSymbols,
    nextOffset,
    receivedCount: loaded.items.length,
    requestedCount: loaded.requestedCount,
    totalCount: symbols.length,
  }
}

export async function previewInternalInstrumentCatalogChunkFromTastytrade(
  env: AppEnv,
  offset: number,
  now = new Date(),
): Promise<InternalInstrumentCatalogChunkRefresh> {
  return internalInstrumentCatalogChunk(env, offset, now, false)
}

/** One bounded ops chunk stays below D1's per-invocation query limit. */
export async function refreshInternalInstrumentCatalogChunkFromTastytrade(
  env: AppEnv,
  offset: number,
  now = new Date(),
): Promise<InternalInstrumentCatalogChunkRefresh> {
  return internalInstrumentCatalogChunk(env, offset, now, true)
}

async function refreshMissingTastytradeInstruments(
  env: AppEnv,
  symbols: readonly string[],
  now = new Date(),
): Promise<void> {
  const missing = await missingInstrumentCatalogSymbols(env, symbols)
  if (missing.length) await refreshTastytradeInstrumentCatalog(env, missing, now)
}

async function loadTastytradeWatchlistSeedPayloads(env: AppEnv): Promise<InternalWatchlistSeedPayloads> {
  const [privatePayload, publicPayload] = await Promise.all([
    tastyRequest(env, '/watchlists'),
    tastyRequest(env, '/public-watchlists'),
  ])
  return { privatePayload, publicPayload }
}

export async function previewInternalWatchlistFromTastytrade(env: AppEnv): Promise<InternalWatchlistSeedPreview> {
  return previewInternalWatchlistSeed(await loadTastytradeWatchlistSeedPayloads(env))
}

/** The only code path that reads tastytrade watchlists: the explicit one-time bootstrap Worker. */
export async function seedInternalWatchlistFromTastytrade(env: AppEnv): Promise<void> {
  await ensureInternalWatchlistSeeded(env, () => loadTastytradeWatchlistSeedPayloads(env))
}

function activeEquityPositionSymbols(positions: readonly JsonObject[]): string[] {
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

/** Fetch position identity before the one-time D1 finalization mutates live rows. */
export async function loadOwnerPositionSymbolsFromTastytrade(env: AppEnv): Promise<string[]> {
  const accountNumber = await resolveAccountNumber(env)
  const payload = await tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`)
  return activeEquityPositionSymbols(strictRows(payload, 'TastytradePositions'))
}

async function loadMarketSnapshot(
  env: AppEnv,
  options: MarketSnapshotOptions = {},
): Promise<MarketSnapshot> {
  const accountNumber = await resolveAccountNumber(env)
  const [positionPayload, sessionPayload] = await Promise.all([
    tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`),
    tastyRequest(env, '/market-time/equities/sessions/current'),
  ])
  const positions = strictRows(positionPayload, 'TastytradePositions')
  const positionSymbols = activeEquityPositionSymbols(positions)
  // Held names reach the watchlist on their own: Dan records the symbols it
  // researches and trades, so a recurring position-to-watchlist sync only
  // re-derived membership that was already there. This call remains because it
  // reduces the one-time seed to the cap and republishes the public universe.
  // Pruning already returns the retained list, so reading it back would repeat
  // the same three queries against a table nothing has touched in between.
  const { kept: focusSymbols } = await pruneInternalWatchlistToFocus(env, MAX_WATCHLIST_SYMBOLS)
  const privateWatchlist: Watchlist = {
    id: 'watchlist',
    kind: 'private',
    name: 'Watchlist',
    symbols: focusSymbols,
  }
  // Current positions are carried as ticker rows with a private `position` flag,
  // never as a second list, so account membership is not itself a watchlist.
  const watchlists = [privateWatchlist]
  const requestedSymbols = (options.symbols ?? [])
    .map((symbol) => EquitySymbolSchema.parse(symbol))
  const symbols = selectSnapshotSymbols(positionSymbols, requestedSymbols, privateWatchlist.symbols)
  // New owner, agent, research, and position symbols get an authoritative name
  // immediately; existing catalog rows wait for the daily full status refresh.
  await refreshMissingTastytradeInstruments(env, symbols)
  const { catalysts, tickers } = await loadMarketFacts(env, symbols, new Set(positionSymbols))
  const marketState = marketStateFromSession(sessionPayload)

  const syncedAt = new Date().toISOString()
  const snapshot = MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    marketState,
    watchlists,
    tickers,
    catalysts,
    research: await loadStoredResearch(env),
  })
  await publishInternalWatchlistUniverse(env, new Date(syncedAt))
  return snapshot
}

/**
 * Account-free public surface. Its read-only watchlist universe is published by owner/server sync;
 * this path never calls account, position, or private-watchlist endpoints. `position` is always false.
 */
export async function loadPublicMarketSnapshot(
  env: AppEnv,
): Promise<MarketSnapshot> {
  const storedUniverse = await loadStoredPublicMarketUniverse(env)
  const publicSymbols = [...new Set(storedUniverse.symbols)]
  const [sessionResult, marketFacts] = await Promise.all([
    tastyRequest(env, '/market-time/equities/sessions/current'),
    loadMarketFacts(env, publicSymbols, new Set()),
  ])
  const syncedAt = new Date().toISOString()
  const watchlists = [{
    id: 'public-options-watch',
    kind: 'public' as const,
    name: 'Options Watch',
    symbols: storedUniverse.symbols,
  }]
  return MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    marketState: marketStateFromSession(sessionResult),
    watchlists,
    tickers: marketFacts.tickers,
    catalysts: marketFacts.catalysts,
    research: await loadStoredResearch(env),
  })
}

/**
 * The slice of the Tastytrade API that the rest of the server reaches for. Production
 * code calls it through `brokerApi()` so a test can install a faithful in-memory broker
 * with `setBrokerApi` instead of replacing this module. Each entry is the
 * implementation above, so the contract type cannot drift from the real signatures.
 */
const brokerApiSeam = defineSeam(() => ({
  loadEquityCandleFromTime,
  loadMarketSnapshot,
  loadPublicMarketSnapshot,
  loadQuoteToken,
  resolveAccountNumber,
  tastyRequest,
  withBrokerMutationLease,
}))

export type BrokerApi = SeamValue<typeof brokerApiSeam>

export const brokerApi = brokerApiSeam.current

export const setBrokerApi = brokerApiSeam.set

export const resetBrokerApi = brokerApiSeam.reset
