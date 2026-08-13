import { demoSnapshot } from '../domain/demo'
import { type CandlePoint } from '../domain/candle'
import {
  MarketSnapshotSchema,
  type MarketSnapshot,
  type Ticker,
  type Watchlist,
} from '../domain/market'
import { type AppEnv, isLiveTastytrade } from './env'
import { readBoundedJson } from './bounded-response'
import { catalystsFromMarketMetrics, earningsDateFromMetric, persistAndLoadCatalysts } from './catalysts'
import { readSecret } from './secrets'
import { tastytradeApiVersion } from './tastytrade-version'

const USER_AGENT = 'Spice/0.1'
const MAX_TASTYTRADE_RESPONSE_BYTES = 16 * 1024 * 1024

type JsonRecord = Record<string, unknown>

let cachedAccess: { expiresAt: number; token: string } | undefined
let accessRefresh: Promise<string> | undefined

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function items(value: unknown): JsonRecord[] {
  if (Array.isArray(value)) return value.map(record)
  const body = record(value)
  if (Array.isArray(body.data)) return body.data.map(record)
  const data = record(body.data)
  const candidate = data.items ?? body.items
  if (Array.isArray(candidate)) return candidate.map(record)
  if (stringValue(data.symbol)) return [data]
  return stringValue(body.symbol) ? [body] : []
}

function numberValue(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** tastytrade volatility metrics are decimal ratios; the UI contract uses percentage points. */
export function percentMetric(value: unknown, max = 100): number | undefined {
  const parsed = numberValue(value)
  return parsed === undefined ? undefined : bounded(parsed * 100, 0, max)
}

function apiBase(env: AppEnv) {
  return env.TASTYTRADE_API_BASE || 'https://api.tastyworks.com'
}

async function refreshAccessToken(env: AppEnv): Promise<string> {
  const [clientSecret, refreshToken] = await Promise.all([
    readSecret(env.TASTYTRADE_CLIENT_SECRET, 'TASTYTRADE_CLIENT_SECRET'),
    readSecret(env.TASTYTRADE_REFRESH_TOKEN, 'TASTYTRADE_REFRESH_TOKEN'),
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
  const payload = record(await readBoundedJson(response, 256_000, 'TastytradeAuth'))
  const token = stringValue(payload.access_token)
  if (!token) throw new Error('TastytradeAuth:missing-token')
  const lifetimeMs = Math.max(1_000, (numberValue(payload.expires_in) ?? 900) * 1_000)
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

async function authorizedRequest(env: AppEnv, path: string, init: RequestInit, token: string): Promise<Response> {
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
): Promise<unknown> {
  let token = await accessToken(env)
  let response = await authorizedRequest(env, path, init, token)
  const method = (init.method ?? 'GET').toUpperCase()
  if (response.status === 401 && (method === 'GET' || method === 'HEAD')) {
    if (cachedAccess?.token === token) cachedAccess = undefined
    token = await accessToken(env)
    response = await authorizedRequest(env, path, init, token)
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

export async function resolveAccountNumber(env: AppEnv): Promise<string> {
  const payload = await tastyRequest(env, '/customers/me/accounts')
  const accounts = items(payload)
  if (accounts.length !== 1) throw new Error('TastytradeAccount:explicit-account-required')
  const account = record(accounts[0]?.account ?? accounts[0])
  const accountNumber = stringValue(account['account-number'])
  if (!accountNumber) throw new Error('TastytradeAccount:not-found')
  return accountNumber
}

export async function loadQuoteToken(env: AppEnv): Promise<{ token: string; url: string }> {
  const payload = record(await tastyRequest(env, '/api-quote-tokens'))
  const data = record(payload.data ?? payload)
  const token = stringValue(data.token)
  const url = stringValue(data['dxlink-url'])
  if (!token || !url || !url.startsWith('wss://')) throw new Error('TastytradeQuoteToken:invalid')
  return { token, url }
}

const CANDLE_FALLBACK_LOOKBACK = 7 * 24 * 60 * 60 * 1_000

export function equityCandleFromTime(payload: unknown, now = Date.now()): number {
  const body = record(payload)
  const session = record(body.data ?? body)
  const currentOpen = Date.parse(stringValue(session['open-at']) ?? '')
  const previous = record(session['previous-session'])
  const previousOpen = Date.parse(stringValue(previous['open-at']) ?? '')
  if (Number.isFinite(currentOpen) && currentOpen <= now) return currentOpen
  if (Number.isFinite(previousOpen) && previousOpen <= now) return previousOpen
  return now - CANDLE_FALLBACK_LOOKBACK
}

export async function loadEquityCandleFromTime(env: AppEnv): Promise<number> {
  return equityCandleFromTime(await tastyRequest(env, '/market-time/equities/sessions/current'))
}

function strictRows(payload: unknown, label: string): JsonRecord[] {
  const body = record(payload)
  const data = record(body.data)
  const candidate = Array.isArray(payload) ? payload : Array.isArray(body.data) ? body.data : data.items ?? body.items
  if (!Array.isArray(candidate)) throw new Error(`${label}:invalid-response`)
  return candidate.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}:invalid-response`)
    return value as JsonRecord
  })
}

function watchlistRows(payload: unknown, kind: Watchlist['kind'], prefix: string): Watchlist[] {
  return strictRows(payload, 'TastytradeWatchlists').map((row, index) => {
    const name = stringValue(row.name)
    if (!name || !Array.isArray(row['watchlist-entries'])) throw new Error('TastytradeWatchlists:invalid-response')
    const entries = row['watchlist-entries'].map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TastytradeWatchlists:invalid-response')
      return value as JsonRecord
    })
    const symbols = [...new Set(entries
      .map((entry) => stringValue(entry.symbol)?.toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol && /^[A-Z.]{1,8}$/.test(symbol))))]
    return { id: `${prefix}-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, kind, name, symbols }
  })
}

export function liveTickerFromRecords(
  symbol: string,
  metrics: JsonRecord | undefined,
  quote: JsonRecord | undefined,
  position: boolean,
): Ticker | undefined {
  if (!metrics || !quote) return undefined
  const price = numberValue(quote.mark ?? quote['mark-price'] ?? quote.last ?? quote['last-price'] ?? quote.close)
  const previousClose = numberValue(quote.prevClose ?? quote['previous-close'] ?? quote.previousClose)
  const explicitChange = numberValue(quote.change)
  const explicitChangePercent = numberValue(quote['change-percent'] ?? quote.changePercent)
  const ivIndex = percentMetric(metrics['implied-volatility-index'], 500)
  const ivRank = percentMetric(metrics['implied-volatility-index-rank'] ?? metrics['implied-volatility-rank'])
  const ivPercentile = percentMetric(metrics['implied-volatility-percentile'])
  const liquidityValue = numberValue(metrics['liquidity-rating'])
  const quoteUpdatedAt = stringValue(quote?.updatedAt ?? quote?.['updated-at'])
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
    name: stringValue(quote.description) ?? symbol,
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
    sources: [],
  }
}

async function loadStoredResearch(env: AppEnv, fallback: MarketSnapshot['research']) {
  if (!env.DB) return fallback
  try {
    const row = await env.DB.prepare(
      'SELECT payload_json FROM research_briefs ORDER BY published_at DESC LIMIT 1',
    ).first<{ payload_json: string }>()
    return row ? JSON.parse(row.payload_json) as MarketSnapshot['research'] : fallback
  } catch {
    return fallback
  }
}

type MarketSnapshotOptions = {
  includeWatchlists?: boolean
  symbols?: readonly string[]
}

export function selectSnapshotSymbols(
  positionSymbols: readonly string[],
  requestedSymbols: readonly string[],
  privateLists: readonly Watchlist[],
  publicLists: readonly Watchlist[],
): string[] {
  return [...new Set([
    ...positionSymbols,
    ...requestedSymbols,
    ...privateLists.flatMap((watchlist) => watchlist.symbols),
    ...publicLists.flatMap((watchlist) => watchlist.symbols),
  ])].slice(0, 100)
}

export async function loadMarketSnapshot(
  env: AppEnv,
  options: MarketSnapshotOptions = {},
): Promise<MarketSnapshot> {
  const demo = demoSnapshot()
  if (!isLiveTastytrade(env)) {
    return { ...demo, research: await loadStoredResearch(env, demo.research) }
  }

  const accountNumber = await resolveAccountNumber(env)
  const includeWatchlists = options.includeWatchlists !== false
  const [privateResult, publicResult, positionResult, sessionResult] = await Promise.allSettled([
    includeWatchlists ? tastyRequest(env, '/watchlists') : Promise.resolve(undefined),
    includeWatchlists ? tastyRequest(env, '/public-watchlists') : Promise.resolve(undefined),
    tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`),
    tastyRequest(env, '/market-time/equities/sessions/current'),
  ])
  if (includeWatchlists && privateResult.status !== 'fulfilled') throw new Error('TastytradeSnapshot:private-watchlists-unavailable')
  if (positionResult.status !== 'fulfilled') throw new Error('TastytradeSnapshot:positions-unavailable')
  const privateLists = includeWatchlists
    ? watchlistRows(privateResult.status === 'fulfilled' ? privateResult.value : [], 'private', 'private')
    : []
  const publicLists = includeWatchlists && publicResult.status === 'fulfilled'
    ? watchlistRows(publicResult.value, 'public', 'public').slice(0, 8)
    : []
  const positions = strictRows(positionResult.value, 'TastytradePositions')
  const positionSymbols = [...new Set(positions
    .filter((position) => (numberValue(position.quantity) ?? 0) !== 0)
    .map((position) => stringValue(position['underlying-symbol']) ?? stringValue(position.symbol))
    .filter((symbol): symbol is string => Boolean(symbol)))]
  const positionList: Watchlist = {
    id: 'positions', kind: 'positions', name: 'Active Positions', symbols: positionSymbols,
  }
  const watchlists = [...privateLists, positionList, ...publicLists]
  const requestedSymbols = (options.symbols ?? [])
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z.]{1,8}$/.test(symbol))
  const symbols = selectSnapshotSymbols(positionSymbols, requestedSymbols, privateLists, publicLists)
  const metricQuery = symbols.map(encodeURIComponent).join(',')
  const marketDataQuery = symbols.map((symbol) => `equity=${encodeURIComponent(symbol)}`).join('&')
  const [metricsResult, marketDataResult] = await Promise.allSettled([
    symbols.length ? tastyRequest(env, `/market-metrics?symbols=${metricQuery}`) : Promise.resolve([]),
    symbols.length ? tastyRequest(env, `/market-data/by-type?${marketDataQuery}`) : Promise.resolve([]),
  ])
  if (symbols.length && (metricsResult.status !== 'fulfilled' || marketDataResult.status !== 'fulfilled')) {
    throw new Error('TastytradeSnapshot:market-data-unavailable')
  }
  const metrics = symbols.length ? strictRows(metricsResult.status === 'fulfilled' ? metricsResult.value : [], 'TastytradeMetrics') : []
  const quotes = symbols.length ? strictRows(marketDataResult.status === 'fulfilled' ? marketDataResult.value : [], 'TastytradeMarketData') : []
  const metricBySymbol = new Map(metrics.map((row) => [stringValue(row.symbol), row]))
  const quoteBySymbol = new Map(quotes.map((row) => [stringValue(row.symbol), row]))
  const tickers = symbols.flatMap((symbol) => {
    const ticker = liveTickerFromRecords(
      symbol,
      metricBySymbol.get(symbol),
      quoteBySymbol.get(symbol),
      positionSymbols.includes(symbol),
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
        hasLiquidity: numberValue(metric?.['liquidity-rating']) !== undefined,
        hasMetric: Boolean(metric),
        hasPreviousClose: numberValue(quote?.prevClose ?? quote?.['previous-close'] ?? quote?.previousClose) !== undefined,
        hasPrice: numberValue(quote?.mark ?? quote?.['mark-price'] ?? quote?.last ?? quote?.['last-price'] ?? quote?.close) !== undefined,
        hasQuote: Boolean(quote),
        hasTimestamp: Number.isFinite(Date.parse(stringValue(quote?.updatedAt ?? quote?.['updated-at']) ?? '')),
      },
      symbolCount: symbols.length,
    }))
    throw new Error('TastytradeSnapshot:no-complete-tickers')
  }
  const metricSymbols = metrics
    .map((metric) => stringValue(metric.symbol)?.toUpperCase())
    .filter((symbol): symbol is string => Boolean(symbol))
  const catalysts = await persistAndLoadCatalysts(
    env,
    catalystsFromMarketMetrics(metrics),
    metricSymbols,
  )
  const session = sessionResult.status === 'fulfilled' ? record(record(sessionResult.value).data ?? sessionResult.value) : {}
  const rawState = (stringValue(session.state) ?? '').toLowerCase()
  const marketState: MarketSnapshot['marketState'] = rawState === 'open'
    ? 'open'
    : rawState.includes('pre') ? 'pre'
      : rawState.includes('after') || rawState.includes('extended') ? 'after'
        : rawState === 'closed' ? 'closed' : 'unknown'

  const syncedAt = new Date().toISOString()
  return MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    marketState,
    watchlists,
    tickers,
    catalysts,
    research: await loadStoredResearch(env, emptyResearch(syncedAt)),
  })
}
