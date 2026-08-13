import { demoSnapshot, demoTickers, demoWatchlists } from '../domain/demo'
import {
  MarketSnapshotSchema,
  type MarketSnapshot,
  type Ticker,
  type Watchlist,
} from '../domain/market'
import { type AppEnv, isLiveTastytrade } from './env'
import { catalystsFromMarketMetrics, earningsDateFromMetric, persistAndLoadCatalysts } from './catalysts'
import { readSecret } from './secrets'

const USER_AGENT = 'SpiceMustFlow/0.1 (+personal-options-dashboard)'
const API_VERSION = '20260427'

type JsonRecord = Record<string, unknown>

let cachedAccess: { expiresAt: number; token: string } | undefined

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

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** tastytrade volatility metrics are decimal ratios; the UI contract uses percentage points. */
export function percentMetric(value: unknown, fallback: number, max = 100): number {
  if (value === undefined || value === null || value === '') return fallback
  return bounded(numberValue(value) * 100, 0, max)
}

function apiBase(env: AppEnv) {
  return env.TASTYTRADE_API_BASE || 'https://api.tastyworks.com'
}

async function accessToken(env: AppEnv): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.token
  const [clientSecret, refreshToken] = await Promise.all([
    readSecret(env.TASTYTRADE_CLIENT_SECRET, 'TASTYTRADE_CLIENT_SECRET'),
    readSecret(env.TASTYTRADE_REFRESH_TOKEN, 'TASTYTRADE_REFRESH_TOKEN'),
  ])
  const response = await fetch(`${apiBase(env)}/oauth/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Accept-Version': API_VERSION,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  })
  if (!response.ok) throw new Error(`TastytradeAuth:${response.status}`)
  const payload = record(await response.json())
  const token = stringValue(payload.access_token)
  if (!token) throw new Error('TastytradeAuth:missing-token')
  const expiresIn = Math.max(60, numberValue(payload.expires_in, 900) - 30)
  cachedAccess = { token, expiresAt: Date.now() + expiresIn * 1_000 }
  return token
}

export async function tastyRequest(
  env: AppEnv,
  path: string,
  init: RequestInit = {},
): Promise<unknown> {
  const token = await accessToken(env)
  const headers = new Headers(init.headers)
  headers.set('Accept', 'application/json')
  headers.set('Accept-Version', API_VERSION)
  headers.set('Authorization', `Bearer ${token}`)
  headers.set('User-Agent', USER_AGENT)
  if (init.body) headers.set('Content-Type', 'application/json')
  const response = await fetch(`${apiBase(env)}${path}`, { ...init, headers })
  if (!response.ok) throw new Error(`TastytradeApi:${response.status}:${path.split('?')[0]}`)
  if (response.status === 204) return {}
  return response.json()
}

export async function resolveAccountNumber(env: AppEnv): Promise<string> {
  if (env.TASTYTRADE_ACCOUNT_NUMBER) return readSecret(env.TASTYTRADE_ACCOUNT_NUMBER, 'TASTYTRADE_ACCOUNT_NUMBER')
  const payload = await tastyRequest(env, '/customers/me/accounts')
  const first = items(payload)[0]
  const account = record(first?.account ?? first)
  const accountNumber = stringValue(account['account-number'])
  if (!accountNumber) throw new Error('TastytradeAccount:not-found')
  return accountNumber
}

function watchlistRows(payload: unknown, kind: Watchlist['kind'], prefix: string): Watchlist[] {
  return items(payload).flatMap((row, index) => {
    const name = stringValue(row.name) ?? `${kind === 'public' ? 'Public' : 'Watchlist'} ${index + 1}`
    const entries = Array.isArray(row['watchlist-entries']) ? row['watchlist-entries'].map(record) : []
    const symbols = [...new Set(entries
      .map((entry) => stringValue(entry.symbol)?.toUpperCase())
      .filter((symbol): symbol is string => Boolean(symbol && /^[A-Z.]{1,8}$/.test(symbol))))]
    return symbols.length ? [{ id: `${prefix}-${index}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, kind, name, symbols }] : []
  })
}

function mergeTicker(
  symbol: string,
  metrics: JsonRecord | undefined,
  quote: JsonRecord | undefined,
  position: boolean,
): Ticker {
  const fallback = demoTickers.find((ticker) => ticker.symbol === symbol)
  const price = numberValue(
    quote?.mark ?? quote?.['mark-price'] ?? quote?.last ?? quote?.['last-price'] ?? quote?.close,
    fallback?.price ?? 0,
  )
  const previousClose = numberValue(quote?.prevClose ?? quote?.['previous-close'] ?? quote?.previousClose, price)
  const change = numberValue(quote?.change, price - previousClose)
  const changePercent = numberValue(
    quote?.['change-percent'] ?? quote?.changePercent,
    previousClose ? (change / previousClose) * 100 : 0,
  )
  const ivIndex = percentMetric(metrics?.['implied-volatility-index'], fallback?.ivIndex ?? 0, 500)
  const quoteUpdatedAt = stringValue(quote?.updatedAt ?? quote?.['updated-at'])
  return {
    symbol,
    name: stringValue(quote?.description) ?? fallback?.name ?? symbol,
    price,
    change,
    changePercent,
    sparkline: quote ? [previousClose, price] : fallback?.sparkline ?? [price, price],
    ivRank: percentMetric(metrics?.['implied-volatility-index-rank'] ?? metrics?.['implied-volatility-rank'], fallback?.ivRank ?? 50),
    ivPercentile: percentMetric(metrics?.['implied-volatility-percentile'], fallback?.ivPercentile ?? 50),
    ivIndex,
    liquidity: bounded(numberValue(metrics?.['liquidity-rating'], fallback?.liquidity ?? 3), 0, 5),
    earningsDate: earningsDateFromMetric(metrics),
    position,
    updatedAt: quoteUpdatedAt && !Number.isNaN(Date.parse(quoteUpdatedAt)) ? new Date(quoteUpdatedAt).toISOString() : new Date().toISOString(),
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

export async function loadMarketSnapshot(env: AppEnv): Promise<MarketSnapshot> {
  const demo = demoSnapshot()
  if (!isLiveTastytrade(env)) {
    return { ...demo, research: await loadStoredResearch(env, demo.research) }
  }

  const accountNumber = await resolveAccountNumber(env)
  const [privateResult, publicResult, positionResult, sessionResult] = await Promise.allSettled([
    tastyRequest(env, '/watchlists'),
    tastyRequest(env, '/public-watchlists'),
    tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`),
    tastyRequest(env, '/market-time/equities/sessions/current'),
  ])
  const privateLists = privateResult.status === 'fulfilled'
    ? watchlistRows(privateResult.value, 'private', 'private')
    : []
  const publicLists = publicResult.status === 'fulfilled'
    ? watchlistRows(publicResult.value, 'public', 'public').slice(0, 8)
    : []
  const positions = positionResult.status === 'fulfilled' ? items(positionResult.value) : []
  const positionSymbols = [...new Set(positions
    .filter((position) => numberValue(position.quantity) !== 0)
    .map((position) => stringValue(position['underlying-symbol']) ?? stringValue(position.symbol))
    .filter((symbol): symbol is string => Boolean(symbol)))]
  const positionList: Watchlist = {
    id: 'positions', kind: 'positions', name: 'Active Positions', symbols: positionSymbols,
  }
  const watchlists = [...privateLists, positionList, ...publicLists]
  const symbols = [...new Set(watchlists.flatMap((watchlist) => watchlist.symbols))].slice(0, 100)
  const metricQuery = symbols.map(encodeURIComponent).join(',')
  const marketDataQuery = symbols.map((symbol) => `equity=${encodeURIComponent(symbol)}`).join('&')
  const [metricsResult, marketDataResult] = await Promise.allSettled([
    tastyRequest(env, `/market-metrics?symbols=${metricQuery}`),
    tastyRequest(env, `/market-data/by-type?${marketDataQuery}`),
  ])
  const metrics = metricsResult.status === 'fulfilled' ? items(metricsResult.value) : []
  const quotes = marketDataResult.status === 'fulfilled' ? items(marketDataResult.value) : []
  const metricBySymbol = new Map(metrics.map((row) => [stringValue(row.symbol), row]))
  const quoteBySymbol = new Map(quotes.map((row) => [stringValue(row.symbol), row]))
  const tickers = symbols.map((symbol) => mergeTicker(
    symbol,
    metricBySymbol.get(symbol),
    quoteBySymbol.get(symbol),
    positionSymbols.includes(symbol),
  ))
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

  return MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt: new Date().toISOString(),
    marketState,
    watchlists: watchlists.length ? watchlists : demoWatchlists,
    tickers: tickers.length ? tickers : demo.tickers,
    catalysts,
    research: await loadStoredResearch(env, demo.research),
  })
}
