import { type CandlePoint } from '../domain/candle'
import { toError } from '../domain/failure'
import { isValidIsoDate } from '../domain/catalyst'
import { EquitySymbolSchema, type InstrumentCatalogItem } from '../domain/instrument'
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
  MAX_MAINTAINED_ITEMS,
  previewInternalWatchlistSeed,
  pruneInternalWatchlistToFocus,
  readInternalWatchlist,
  readInternalWatchlistCatalogCandidates,
  type InternalWatchlistSeedPayloads,
  type InternalWatchlistSeedPreview,
} from './internal-watchlist'
import {
  envelopeRows,
  JsonArraySchema,
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
import { persistTastytradeMarketSnapshot } from './tastytrade-market-store'
import {
  loadStoredPublicMarketUniverse,
  MAX_PUBLIC_MARKET_SYMBOLS,
  persistPublicMarketUniverse,
} from './public-market-universe'

const USER_AGENT = 'Spice/0.1'
const MAX_TASTYTRADE_RESPONSE_BYTES = 16 * 1024 * 1024
let cachedAccess: { expiresAt: number; token: string } | undefined

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function previousCloseValue(quote: JsonObject | undefined): number | undefined {
  return jsonNumber(
    quote?.prevClose
    ?? quote?.['prev-close']
    ?? quote?.previousClose
    ?? quote?.['previous-close']
    ?? quote?.prevDayClose
    ?? quote?.['prev-day-close'],
  )
}

/** tastytrade volatility metrics are decimal ratios; the UI contract uses percentage points. */
export function percentMetric(value: JsonValue, max = 100): number | undefined {
  const parsed = jsonNumber(value)
  return parsed === undefined ? undefined : bounded(parsed * 100, 0, max)
}

/** Rate deltas and borrow costs use the same decimal-ratio wire format but may be negative. */
function signedPercentMetric(value: JsonValue, maxAbsolute = 10_000): number | undefined {
  const parsed = jsonNumber(value)
  return parsed === undefined ? undefined : bounded(parsed * 100, -maxAbsolute, maxAbsolute)
}

function optionTermStructure(metrics: JsonObject): Ticker['ivTermStructure'] {
  const rows = JsonArraySchema.safeParse(
    metrics['option-expiration-implied-volatilities'] ?? metrics.optionExpirationImpliedVolatilities,
  ).data ?? []
  const candidates = rows.flatMap((value) => {
    const row = jsonObject(value)
    const rawExpiration = jsonText(row?.['expiration-date'] ?? row?.expirationDate)
    const expiration = rawExpiration?.slice(0, 10)
    const impliedVolatility = percentMetric(row?.['implied-volatility'] ?? row?.impliedVolatility, 1_000)
    if (!expiration || !isValidIsoDate(expiration) || impliedVolatility === undefined) return []
    return [{
      chainType: jsonText(row?.['option-chain-type'] ?? row?.optionChainType) ?? '',
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
  if (instrument['is-index'] === true || instrument.isIndex === true) return 'index'
  if (instrument['is-etf'] === true || instrument.isEtf === true) return 'etf'
  return 'stock'
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
  const lifetimeMs = Math.max(1_000, (jsonNumber(payload.expires_in) ?? 900) * 1_000)
  const skewMs = Math.min(30_000, Math.max(1_000, lifetimeMs * 0.1))
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
  return readBoundedJson(response, MAX_TASTYTRADE_RESPONSE_BYTES, 'TastytradeApi')
}

async function resolveAccountNumber(env: AppEnv): Promise<string> {
  const payload = await tastyRequest(env, '/customers/me/accounts')
  const accounts = envelopeRows(payload) ?? []
  if (accounts.length !== 1) throw new Error('TastytradeAccount:explicit-account-required')
  const row = jsonObjectOrEmpty(accounts[0])
  const account = jsonObjectOrEmpty(row.account ?? row)
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

const CANDLE_FALLBACK_LOOKBACK = 7 * 24 * 60 * 60 * 1_000

export function equityCandleFromTime(payload: JsonValue, now = Date.now()): number {
  const body = jsonObjectOrEmpty(payload)
  const session = jsonObjectOrEmpty(body.data ?? body)
  const currentOpen = Date.parse(jsonText(session['open-at']) ?? '')
  const previous = jsonObjectOrEmpty(session['previous-session'])
  const previousOpen = Date.parse(jsonText(previous['open-at']) ?? '')
  if (Number.isFinite(currentOpen) && currentOpen <= now) return currentOpen
  if (Number.isFinite(previousOpen) && previousOpen <= now) return previousOpen
  return now - CANDLE_FALLBACK_LOOKBACK
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

export function liveTickerFromRecords(
  symbol: string,
  metrics: JsonObject | undefined,
  quote: JsonObject | undefined,
  position: boolean,
  instrument?: JsonObject,
): Ticker | undefined {
  if (!metrics || !quote) return undefined
  const price = jsonNumber(quote.mark ?? quote['mark-price'] ?? quote.last ?? quote['last-price'] ?? quote.close)
  const previousClose = previousCloseValue(quote)
  const explicitChange = jsonNumber(quote.change)
  const explicitChangePercent = jsonNumber(quote['change-percent'] ?? quote.changePercent)
  const ivIndex = percentMetric(metrics['implied-volatility-index'], 500)
  const ivRank = percentMetric(metrics['implied-volatility-index-rank'] ?? metrics['implied-volatility-rank'])
  const ivPercentile = percentMetric(metrics['implied-volatility-percentile'])
  const liquidityValue = jsonNumber(metrics['liquidity-rating'])
  const marketCap = jsonNumber(metrics['market-cap'] ?? metrics.marketCap)
  const volume = jsonNumber(quote.volume ?? quote['day-volume'])
  const candidateYearLow = jsonNumber(quote.yearLowPrice ?? quote['year-low-price'])
  const candidateYearHigh = jsonNumber(quote.yearHighPrice ?? quote['year-high-price'])
  const hasYearRange = candidateYearLow !== undefined && candidateYearLow > 0
    && candidateYearHigh !== undefined && candidateYearHigh > candidateYearLow
  const quoteUpdatedAt = jsonText(quote?.updatedAt ?? quote?.['updated-at'])
  const quoteTime = Date.parse(quoteUpdatedAt ?? '')
  if (price === undefined || price <= 0 || previousClose === undefined || previousClose <= 0
    || ivIndex === undefined || ivRank === undefined || ivPercentile === undefined
    || liquidityValue === undefined || !Number.isFinite(quoteTime)) return undefined
  const change = explicitChange ?? price - previousClose
  const changePercent = explicitChangePercent ?? (change / previousClose) * 100
  const sparkline: CandlePoint[] = [
    { time: quoteTime - 5 * 60 * 1_000, sequence: 0, close: previousClose },
    { time: quoteTime, sequence: 0, close: price },
  ]
  return {
    symbol,
    name: jsonText(instrument?.description ?? instrument?.['short-description'] ?? quote.description) ?? symbol,
    assetType: assetType(instrument),
    borrowRate: signedPercentMetric(metrics['borrow-rate'] ?? instrument?.['borrow-rate'] ?? instrument?.borrowRate),
    lendability: jsonText(metrics.lendability ?? instrument?.lendability),
    marketCap: marketCap !== undefined && marketCap >= 0 ? marketCap : undefined,
    price,
    change,
    changePercent,
    sparkline,
    ivRank,
    ivPercentile,
    ivIndex,
    ivIndex5DayChange: signedPercentMetric(
      metrics['implied-volatility-index-5-day-change'] ?? metrics.impliedVolatilityIndex5DayChange,
      1_000,
    ),
    historicalVolatility30Day: percentMetric(
      metrics['historical-volatility-30-day'] ?? metrics.historicalVolatility30Day,
      1_000,
    ),
    ivHistoricalVolatility30DayDifference: signedPercentMetric(
      metrics['iv-hv-30-day-difference'] ?? metrics.ivHv30DayDifference,
      1_000,
    ),
    ivTermStructure: optionTermStructure(metrics),
    liquidity: bounded(liquidityValue, 0, 5),
    volume: volume !== undefined && volume >= 0 ? volume : undefined,
    yearHigh: hasYearRange ? candidateYearHigh : undefined,
    yearLow: hasYearRange ? candidateYearLow : undefined,
    earningsDate: earningsDateFromMetric(metrics),
    position,
    updatedAt: new Date(quoteTime).toISOString(),
  }
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

function emptyResearch(now: string): MarketSnapshot['research'] {
  return {
    id: `research-unavailable-${now.slice(0, 10)}`,
    publishedAt: now,
    title: 'No market brief yet',
    summary: 'The next verified daily market brief has not been published.',
    regime: 'Waiting for research',
    regimeDetail: 'No stored live brief',
    ideas: [],
    marketMovers: [],
    sources: [],
  }
}

async function loadStoredResearch(env: AppEnv, fallback: MarketSnapshot['research']) {
  if (!env.DB) return fallback
  let stored: JsonValue
  try {
    const row = await env.DB.prepare(
      'SELECT payload_json FROM research_briefs ORDER BY published_at DESC LIMIT 1',
    ).first<{ payload_json: string }>()
    if (!row) return fallback
    stored = JSON.parse(row.payload_json)
  } catch {
    return fallback
  }
  try {
    return parseStoredResearchBrief(stored)
  } catch {
    return fallback
  }
}

type MarketSnapshotOptions = {
  symbols?: readonly string[]
}

function marketStateFromSession(payload: JsonValue | undefined): MarketSnapshot['marketState'] {
  const session = jsonObjectOrEmpty(jsonObjectOrEmpty(payload).data ?? payload)
  const rawState = (jsonText(session.state) ?? '').toLowerCase()
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
  const [[metricsResult, marketDataResult], instrumentCatalog] = await Promise.all([
    Promise.allSettled([
      symbols.length ? tastyRequest(env, `/market-metrics?symbols=${metricQuery}`) : Promise.resolve([]),
      symbols.length ? tastyRequest(env, `/market-data/by-type?${marketDataQuery}`) : Promise.resolve([]),
    ]),
    readInstrumentCatalog(env, symbols),
  ])
  // With no symbols both entries resolve to an empty array, so an empty request settles
  // fulfilled and `strictRows` reads back no rows.
  if (metricsResult.status !== 'fulfilled' || marketDataResult.status !== 'fulfilled') {
    throw new Error('TastytradeSnapshot:market-data-unavailable')
  }
  const metrics = strictRows(metricsResult.value, 'TastytradeMetrics')
  const quotes = strictRows(marketDataResult.value, 'TastytradeMarketData')
  const metricBySymbol = new Map(metrics.map((row) => [jsonText(row.symbol), row]))
  const quoteBySymbol = new Map(quotes.map((row) => [jsonText(row.symbol), row]))
  const tickers = symbols.flatMap((symbol) => {
    const ticker = liveTickerFromRecords(
      symbol,
      metricBySymbol.get(symbol),
      quoteBySymbol.get(symbol),
      positionSymbols.has(symbol),
      catalogTickerInstrument(instrumentCatalog.get(symbol)),
    )
    return ticker ? [ticker] : []
  })
  if (symbols.length && tickers.length === 0) {
    const metric = metricBySymbol.get(symbols[0]!)
    const quote = quoteBySymbol.get(symbols[0]!)
    console.error('TastytradeSnapshotIncompleteTicker', JSON.stringify({
      metricCount: metrics.length,
      quoteCount: quotes.length,
      sample: {
        hasIvIndex: percentMetric(metric?.['implied-volatility-index'], 500) !== undefined,
        hasIvPercentile: percentMetric(metric?.['implied-volatility-percentile']) !== undefined,
        hasIvRank: percentMetric(metric?.['implied-volatility-index-rank'] ?? metric?.['implied-volatility-rank']) !== undefined,
        hasLiquidity: jsonNumber(metric?.['liquidity-rating']) !== undefined,
        hasMetric: Boolean(metric),
        hasPreviousClose: previousCloseValue(quote) !== undefined,
        hasPrice: jsonNumber(quote?.mark ?? quote?.['mark-price'] ?? quote?.last ?? quote?.['last-price'] ?? quote?.close) !== undefined,
        hasQuote: Boolean(quote),
        hasTimestamp: Number.isFinite(Date.parse(jsonText(quote?.updatedAt ?? quote?.['updated-at']) ?? '')),
      },
      symbolCount: symbols.length,
    }))
    throw new Error('TastytradeSnapshot:no-complete-tickers')
  }
  const metricSymbols = metrics
    .map((metric) => jsonText(metric.symbol)?.toUpperCase())
    .filter((symbol): symbol is string => Boolean(symbol))
  const allCatalysts = await persistAndLoadCatalysts(
    env,
    catalystsFromMarketMetrics(metrics),
    metricSymbols,
  )
  await persistTastytradeMarketSnapshot(env, tickers).catch((cause) => {
    console.error('TastytradeMarketStoreFailed', toError(cause)?.message ?? 'UnknownError')
  })
  const allowedSymbols = new Set(symbols)
  return {
    tickers,
    catalysts: allCatalysts.filter((catalyst) => allowedSymbols.has(catalyst.symbol)),
  }
}

export function selectSnapshotSymbols(
  positionSymbols: readonly string[],
  requestedSymbols: readonly string[],
  internalWatchlistSymbols: readonly string[],
): string[] {
  return [...new Set([
    ...requestedSymbols,
    ...positionSymbols,
    ...internalWatchlistSymbols,
  ])].slice(0, MAX_PUBLIC_MARKET_SYMBOLS)
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
  const bulk = await loadInstrumentCatalog(
    symbols,
    (chunk) => tastyRequest(env, equityInstrumentPath(chunk)),
    now,
  )
  const recovered: InstrumentCatalogItem[] = []
  for (const symbol of bulk.missingSymbols) {
    try {
      const single = await loadInstrumentCatalog(
        [symbol],
        () => tastyRequest(env, `/instruments/equities/${encodeURIComponent(symbol)}`),
        now,
      )
      recovered.push(...single.items)
    } catch {
      // Missing or non-Equity watchlist rows remain explicit in the operation result.
    }
  }
  const items = [...bulk.items, ...recovered]
  const received = new Set(items.map((item) => item.symbol))
  return {
    items,
    missingSymbols: symbols.filter((symbol) => !received.has(symbol)),
    requestedCount: bulk.requestedCount,
  }
}

/** Refresh the typed catalog from tastytrade without retaining its raw response. */
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

/** Daily catalog job covers the full maintained list. */
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
  const chunk = symbols.slice(offset, offset + MAX_PUBLIC_MARKET_SYMBOLS)
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

/** Preview one bounded provider chunk without writing its typed projection. */
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
  return [...new Set(positions
    .filter((position) => (jsonNumber(position.quantity) ?? 0) !== 0)
    .map((position) => EquitySymbolSchema.safeParse(
      jsonText(position['underlying-symbol']) ?? jsonText(position.symbol),
    ).data)
    .filter((symbol): symbol is string => Boolean(symbol)))]
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
    tastyRequest(env, '/market-time/equities/sessions/current').catch(() => undefined),
  ])
  const positions = strictRows(positionPayload, 'TastytradePositions')
  const positionSymbols = activeEquityPositionSymbols(positions)
  // Held names reach the watchlist on their own: Dan records the symbols it
  // researches and trades, so a recurring position-to-watchlist sync only
  // re-derived membership that was already there. This call remains because it
  // reduces the one-time seed to the cap and republishes the public universe.
  // Pruning already returns the retained list, so reading it back would repeat
  // the same three queries against a table nothing has touched in between.
  const { kept: focusSymbols } = await pruneInternalWatchlistToFocus(env, MAX_MAINTAINED_ITEMS)
  const privateWatchlist: Watchlist = {
    id: 'watchlist',
    kind: 'private',
    name: 'Watchlist',
    symbols: focusSymbols,
  }
  // The owner sees exactly one list: the D1 internal watchlist. Position symbols are
  // never surfaced as their own list — they stay a `position-sync` origin, a focus
  // priority, and the per-ticker `position` flag, so account membership is not a list.
  const watchlists = [privateWatchlist]
  const requestedSymbols = (options.symbols ?? [])
    .map((symbol) => EquitySymbolSchema.safeParse(symbol).data)
    .filter((symbol): symbol is string => Boolean(symbol))
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
    research: await loadStoredResearch(env, emptyResearch(syncedAt)),
  })
  await persistPublicMarketUniverse(env, new Date(syncedAt))
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
  const publicSymbols = [...new Set((storedUniverse?.symbols ?? [])
    .map((symbol) => EquitySymbolSchema.safeParse(symbol).data)
    .filter((symbol): symbol is string => Boolean(symbol)))]
    .slice(0, MAX_PUBLIC_MARKET_SYMBOLS)
  const [sessionResult, marketFacts] = await Promise.all([
    tastyRequest(env, '/market-time/equities/sessions/current').catch(() => undefined),
    loadMarketFacts(env, publicSymbols, new Set()),
  ])
  const syncedAt = new Date().toISOString()
  const watchlists = [{
    id: 'public-options-watch',
    kind: 'public' as const,
    name: 'Options Watch',
    symbols: storedUniverse?.symbols ?? [],
  }]
  return MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    marketState: marketStateFromSession(sessionResult),
    watchlists,
    tickers: marketFacts.tickers,
    catalysts: marketFacts.catalysts,
    research: await loadStoredResearch(env, emptyResearch(syncedAt)),
  })
}

/**
 * The slice of the Tastytrade API that the rest of the server reaches for. Production
 * code calls it through `brokerApi()` so a test can install a faithful in-memory broker
 * with `setBrokerApi` instead of replacing this module. Each entry is the
 * implementation above, so the contract type cannot drift from the real signatures.
 */
function createBrokerApi() {
  return {
    loadEquityCandleFromTime,
    loadMarketSnapshot,
    loadPublicMarketSnapshot,
    loadQuoteToken,
    resolveAccountNumber,
    tastyRequest,
    withBrokerMutationLease,
  }
}

export type BrokerApi = ReturnType<typeof createBrokerApi>

let installedBrokerApi: BrokerApi = createBrokerApi()

/** The broker calls currently in force. */
export function brokerApi(): BrokerApi {
  return installedBrokerApi
}

/** Install a stand-in broker for a test; pair every call with `resetBrokerApi()`. */
export function setBrokerApi(next: BrokerApi): void {
  installedBrokerApi = next
}

/** Restore the live Tastytrade calls. */
export function resetBrokerApi(): void {
  installedBrokerApi = createBrokerApi()
}
