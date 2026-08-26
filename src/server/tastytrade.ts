import { type CandlePoint } from '../domain/candle'
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
  readInternalWatchlist,
  selectInternalWatchlistFocus,
  type InternalWatchlistSeedPayloads,
  type InternalWatchlistSeedPreview,
} from './internal-watchlist'
import {
  JsonArraySchema,
  jsonNumber,
  JsonObjectArraySchema,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { readStoredSecret } from './secrets'
import { tastytradeApiVersion } from './tastytrade-version'
import {
  loadStoredPublicMarketUniverse,
  MAX_PUBLIC_MARKET_SYMBOLS,
  persistPublicMarketUniverse,
} from './public-market-universe'

export { publicMarketUniverseFromSnapshot } from './public-market-universe'

const USER_AGENT = 'Spice/0.1'
const MAX_TASTYTRADE_RESPONSE_BYTES = 16 * 1024 * 1024
let cachedAccess: { expiresAt: number; token: string } | undefined
let accessRefresh: Promise<string> | undefined

function items(value: JsonValue): JsonObject[] {
  const rows = JsonArraySchema.safeParse(value).data
  if (rows) return rows.map(jsonObjectOrEmpty)
  const body = jsonObjectOrEmpty(value)
  const dataRows = JsonArraySchema.safeParse(body.data).data
  if (dataRows) return dataRows.map(jsonObjectOrEmpty)
  const data = jsonObjectOrEmpty(body.data)
  const candidate = JsonArraySchema.safeParse(data.items ?? body.items).data
  if (candidate) return candidate.map(jsonObjectOrEmpty)
  if (jsonText(data.symbol)) return [data]
  return jsonText(body.symbol) ? [body] : []
}

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
  accessRefresh ??= refreshAccessToken(env).finally(() => {
    accessRefresh = undefined
  })
  return accessRefresh
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
  const accounts = items(payload)
  if (accounts.length !== 1) throw new Error('TastytradeAccount:explicit-account-required')
  const account = jsonObjectOrEmpty(accounts[0]?.account ?? accounts[0])
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
  const body = jsonObjectOrEmpty(payload)
  const data = jsonObjectOrEmpty(body.data)
  const candidate = JsonArraySchema.safeParse(payload).data
    ?? JsonArraySchema.safeParse(body.data).data
    ?? JsonArraySchema.safeParse(data.items ?? body.items).data
  const rows = candidate && JsonObjectArraySchema.safeParse(candidate).data
  if (!rows) throw new Error(`${label}:invalid-response`)
  return rows
}

function optionalRows(payload: JsonValue, label: string): JsonObject[] {
  try {
    return strictRows(payload, label)
  } catch {
    return []
  }
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
    price,
    change,
    changePercent,
    sparkline,
    ivRank,
    ivPercentile,
    ivIndex,
    liquidity: bounded(liquidityValue, 0, 5),
    earningsDate: earningsDateFromMetric(metrics),
    position,
    updatedAt: new Date(quoteTime).toISOString(),
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
  const session = payload === undefined
    ? {}
    : jsonObjectOrEmpty(jsonObjectOrEmpty(payload).data ?? payload)
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
  const instrumentQuery = symbols.map((symbol) => `symbol[]=${encodeURIComponent(symbol)}`).join('&')
  const [metricsResult, marketDataResult, instrumentsResult] = await Promise.allSettled([
    symbols.length ? tastyRequest(env, `/market-metrics?symbols=${metricQuery}`) : Promise.resolve([]),
    symbols.length ? tastyRequest(env, `/market-data/by-type?${marketDataQuery}`) : Promise.resolve([]),
    symbols.length ? tastyRequest(env, `/instruments/equities?${instrumentQuery}`) : Promise.resolve([]),
  ])
  if (symbols.length && (metricsResult.status !== 'fulfilled' || marketDataResult.status !== 'fulfilled')) {
    throw new Error('TastytradeSnapshot:market-data-unavailable')
  }
  const metrics = symbols.length
    ? strictRows(metricsResult.status === 'fulfilled' ? metricsResult.value : [], 'TastytradeMetrics')
    : []
  const quotes = symbols.length
    ? strictRows(marketDataResult.status === 'fulfilled' ? marketDataResult.value : [], 'TastytradeMarketData')
    : []
  // Instrument names improve identity checks, but a transient catalog failure
  // or malformed optional response must not take the public volatility snapshot offline.
  const instruments = symbols.length && instrumentsResult.status === 'fulfilled'
    ? optionalRows(instrumentsResult.value, 'TastytradeInstruments')
    : []
  const metricBySymbol = new Map(metrics.map((row) => [jsonText(row.symbol), row]))
  const quoteBySymbol = new Map(quotes.map((row) => [jsonText(row.symbol), row]))
  const instrumentBySymbol = new Map(instruments.map((row) => [jsonText(row.symbol), row]))
  const tickers = symbols.flatMap((symbol) => {
    const ticker = liveTickerFromRecords(
      symbol,
      metricBySymbol.get(symbol),
      quoteBySymbol.get(symbol),
      positionSymbols.has(symbol),
      instrumentBySymbol.get(symbol),
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

async function loadMarketSnapshot(
  env: AppEnv,
  options: MarketSnapshotOptions = {},
): Promise<MarketSnapshot> {
  const accountNumber = await resolveAccountNumber(env)
  const [internalItems, positionPayload, sessionPayload] = await Promise.all([
    readInternalWatchlist(env),
    tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`),
    tastyRequest(env, '/market-time/equities/sessions/current').catch(() => undefined),
  ])
  const positions = strictRows(positionPayload, 'TastytradePositions')
  const positionSymbols = [...new Set(positions
    .filter((position) => (jsonNumber(position.quantity) ?? 0) !== 0)
    .map((position) => jsonText(position['underlying-symbol']) ?? jsonText(position.symbol))
    .filter((symbol): symbol is string => Boolean(symbol)))]
  const positionList: Watchlist = {
    id: 'positions', kind: 'positions', name: 'Active Positions', symbols: positionSymbols,
  }
  const focusSymbols = selectInternalWatchlistFocus(internalItems, positionSymbols, MAX_PUBLIC_MARKET_SYMBOLS)
  const privateWatchlist: Watchlist = {
    id: 'watchlist',
    kind: 'private',
    name: 'Watchlist',
    symbols: focusSymbols,
  }
  const watchlists = [positionList, privateWatchlist]
  const requestedSymbols = (options.symbols ?? [])
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z.]{1,8}$/.test(symbol))
  const symbols = selectSnapshotSymbols(positionSymbols, requestedSymbols, privateWatchlist.symbols)
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
  await persistPublicMarketUniverse(env, snapshot)
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
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z.]{1,8}$/.test(symbol)))]
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
