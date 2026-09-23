import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import {
  MarketSnapshotSchema,
  PublicMarketSnapshotSchema,
  type MarketSnapshot,
  type PublicMarketSnapshot,
  type Watchlist,
  publicTickerFromTicker,
  type PublicSymbolLookup,
} from '../domain/market'
import { type AppEnv } from './env'
import { readBoundedJson } from './bounded-response'
import { catalystsFromMarketMetrics, persistAndLoadCatalysts, readUpcomingCatalysts } from './catalysts'
import {
  ensureInternalWatchlistSeeded,
  ensureInternalWatchlistSymbols,
  previewInternalWatchlistSeed,
  readInternalWatchlistCatalogCandidates,
  readInternalWatchlistFocus,
  type InternalWatchlistSeedPayloads,
  type InternalWatchlistSeedPreview,
} from './internal-watchlist'
import {
  envelopeRows,
  jsonNumber,
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
  catalogTickerInstrument,
  marketClosesAtFromTastytradeSession,
  marketOpensAtFromTastytradeSession,
  marketStateFromTastytradeSession,
  tickerFromStoredRecords,
  normalizeTastytradeMarketTicker,
  strictTastytradeRows,
  tastytradeRowsByRequestedSymbol,
} from './tastytrade-market-normalization'
import { defineSeam, type SeamValue } from './seam'
import { searchInstrumentCatalog, symbolCandidate } from './symbol-search'
import { loadStoredPublicMarketUniverse, publishInternalWatchlistUniverse } from './public-market-universe'
import { readYearAgoCloses } from './year-candle-store'
import { readLatestDailyBrief } from './daily-brief-store'
import {
  BrokerCredentialMissingError,
  type BrokerCredential,
} from './broker-credential'
import {
  claimMarketRefresh,
  persistMarketSession,
  readStoredMarketRecords,
  readStoredMarketSession,
  type TastytradeMarketQuoteRecord,
} from './tastytrade-market-store'
import { CallerVisibleError } from './caller-visible-error'

const USER_AGENT = 'Heston/0.1'
/**
 * The symbols one tastytrade request names. tastytrade's market-data endpoint documents a
 * combined limit of 100 symbols per request, and every symbol-listing read here — metrics,
 * quotes, the equity instruments catalog — pages by this one figure. It is deliberately
 * independent of how long the watchlist grows: the list is paged into requests, never sent as
 * one URL. D1 persistence does not borrow it; storage chunks by `d1-limits`.
 */
export const BROKER_SYMBOL_CHUNK_SIZE = 100
/**
 * How long one tastytrade request may take before it is abandoned. A named budget rather than a
 * provider figure: it keeps one hung request inside the public refresh claim, which assumes a
 * slow provider answers well within its lease.
 */
const TASTYTRADE_REQUEST_TIMEOUT_MS = 20_000
// An OAuth token response is a handful of fields; this bounds the buffered parse of one.
const MAX_TASTYTRADE_AUTH_RESPONSE_BYTES = 256_000
// A cached token must outlive any request it is handed to, so it is retired one request timeout
// before the provider's expiry — or a tenth of its life, for a token too short-lived to spare a
// whole timeout and still be worth caching.
const TOKEN_EXPIRY_SKEW_MS = TASTYTRADE_REQUEST_TIMEOUT_MS
const MAX_TOKEN_EXPIRY_SKEW_FRACTION = 0.1
// Provider JSON is buffered for strict parsing; stay within the Worker isolate memory budget
// while allowing the catalog endpoints, which are substantially larger than normal reads.
const MAX_TASTYTRADE_RESPONSE_BYTES = 16 * 1024 * 1024
// This cache contains only the Worker's market-data token. A per-request account token is
// never cached across requests because this module state is shared by every isolate user.
let cachedAccess: { expiresAt: number; token: string } | undefined

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
    signal: AbortSignal.timeout(TASTYTRADE_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`TastytradeAuth:${response.status}`)
  }
  const payload = jsonObjectOrEmpty(await readBoundedJson(response, MAX_TASTYTRADE_AUTH_RESPONSE_BYTES, 'TastytradeAuth'))
  const token = jsonText(payload.access_token)
  if (!token) throw new CallerVisibleError('TastytradeAuth:missing-token')
  const lifetimeSeconds = jsonNumber(payload.expires_in)
  if (lifetimeSeconds === undefined || !Number.isSafeInteger(lifetimeSeconds) || lifetimeSeconds <= 0) {
    throw new CallerVisibleError('TastytradeAuth:invalid-token-lifetime')
  }
  const lifetimeMs = lifetimeSeconds * 1_000
  const skewMs = Math.min(TOKEN_EXPIRY_SKEW_MS, lifetimeMs * MAX_TOKEN_EXPIRY_SKEW_FRACTION)
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

/** The account's mutation lease lapsed before the next broker step, so nothing further was sent. */
export class BrokerMutationLeaseExpiredError extends CallerVisibleError {
  constructor() {
    super('BrokerMutationLeaseExpired')
    this.name = 'BrokerMutationLeaseExpiredError'
  }
}

function requestGate(env: AppEnv, accountNumber?: string): BrokerRequestGate {
  // Broker coordination is part of the provider safety boundary. Validate the
  // binding before reading credentials so a misbound deployment cannot silently
  // bypass request throttling.
  const namespace = env.BROKER_GATE
  if (!namespace) throw new CallerVisibleError('TastytradeCoordinatorUnavailable')
  // A rate budget belongs to one broker account, so two members' account work must not
  // share a gate. Market requests and initial account discovery have no account number.
  return namespace.getByName(accountNumber ? `tastytrade:${accountNumber}` : 'tastytrade:market')
}

/**
 * Serialize one broker read-modify-write sequence across Worker isolates. Renewals
 * are explicit so callers can prove the durable lease is still theirs immediately
 * before each broker mutation. A failed cleanup must not obscure an accepted or
 * ambiguous broker result; the persisted lease expires on its own as a backstop.
 */
export async function withBrokerMutationLease<T>(
  env: AppEnv,
  accountNumber: string,
  operation: (lease: BrokerMutationLease) => Promise<T>,
): Promise<T> {
  if (!accountNumber) throw new CallerVisibleError('TastytradeAccount:invalid-account-number')
  const gate = requestGate(env, accountNumber)
  const token = await gate.acquireMutation()
  try {
    return await operation({
      renew: async () => {
        if (!await gate.renewMutation(token)) throw new BrokerMutationLeaseExpiredError()
      },
    })
  } finally {
    try {
      await gate.releaseMutation(token)
    } catch {
      console.error('BrokerMutationLeaseReleaseFailed')
    }
  }
}

function isAccountPath(path: string): boolean {
  return path.startsWith('/accounts/') || path.startsWith('/customers/')
}

function accountNumberFromPath(path: string): string | undefined {
  if (!path.startsWith('/accounts/')) return undefined
  const encoded = path.slice('/accounts/'.length).split(/[/?]/, 1)[0]
  if (!encoded) throw new CallerVisibleError('TastytradeAccount:invalid-path-account')
  try {
    const accountNumber = decodeURIComponent(encoded)
    if (!accountNumber) throw new CallerVisibleError('TastytradeAccount:invalid-path-account')
    return accountNumber
  } catch {
    throw new CallerVisibleError('TastytradeAccount:invalid-path-account')
  }
}

async function tokenForPath(
  env: AppEnv,
  path: string,
  credential: BrokerCredential | undefined,
): Promise<string> {
  if (!isAccountPath(path)) return accessToken(env)
  if (credential?.broker !== 'tastytrade' || !credential.accessToken.trim()) {
    throw new BrokerCredentialMissingError()
  }
  return credential.accessToken
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
  const timeout = AbortSignal.timeout(TASTYTRADE_REQUEST_TIMEOUT_MS)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(`${apiBase(env)}${path}`, { ...init, headers, signal })
}

export async function tastyRequest(
  env: AppEnv,
  path: string,
  init: RequestInit = {},
  credential?: BrokerCredential,
): Promise<JsonValue> {
  const accountPath = isAccountPath(path)
  // Account credentials are checked before any platform or network I/O. Market requests
  // retain the existing coordinator-first failure order before stored secrets are read.
  let token = accountPath ? await tokenForPath(env, path, credential) : undefined
  const gate = requestGate(env, accountNumberFromPath(path))
  token ??= await tokenForPath(env, path, credential)
  let response = await authorizedRequest(env, path, init, token, gate)
  const method = (init.method ?? 'GET').toUpperCase()
  if (!accountPath && response.status === 401 && (method === 'GET' || method === 'HEAD')) {
    if (cachedAccess?.token === token) cachedAccess = undefined
    await response.body?.cancel()
    token = await tokenForPath(env, path, credential)
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

async function resolveAccountNumber(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): Promise<string> {
  const payload = await tastyRequest(env, '/customers/me/accounts', {}, credential)
  const accounts = envelopeRows(payload)
  if (!accounts) throw new CallerVisibleError('TastytradeAccount:invalid-accounts')
  if (accounts.length !== 1) throw new CallerVisibleError('TastytradeAccount:explicit-account-required')
  const row = jsonObject(accounts[0])
  if (!row) throw new CallerVisibleError('TastytradeAccount:invalid-account')
  const account = jsonObject(row.account ?? row)
  if (!account) throw new CallerVisibleError('TastytradeAccount:invalid-account')
  const accountNumber = jsonText(account['account-number'])
  if (!accountNumber) throw new CallerVisibleError('TastytradeAccount:not-found')
  return accountNumber
}

async function loadQuoteToken(env: AppEnv): Promise<{ token: string; url: string }> {
  const payload = jsonObjectOrEmpty(await tastyRequest(env, '/api-quote-tokens'))
  const data = jsonObjectOrEmpty(payload.data ?? payload)
  const token = jsonText(data.token)
  const url = jsonText(data['dxlink-url'])
  if (!token || !url || !url.startsWith('wss://')) throw new CallerVisibleError('TastytradeQuoteToken:invalid')
  return { token, url }
}

/** Both audiences read the same brief; a missing store is a fault, never an empty brief. */
async function loadStoredBrief(env: AppEnv): Promise<MarketSnapshot['brief']> {
  if (!env.DB) throw new CallerVisibleError('DailyBrief:store-unavailable')
  return readLatestDailyBrief(env.DB)
}

/** Both market reads name every symbol in the query string, so a long watchlist is
 *  fetched in request-sized chunks rather than in one URL the provider would reject. */
async function loadMarketRows(
  env: AppEnv,
  symbols: readonly string[],
): Promise<{ metrics: JsonObject[]; quotes: JsonObject[] }> {
  const metrics: JsonObject[] = []
  const quotes: JsonObject[] = []
  for (let start = 0; start < symbols.length; start += BROKER_SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + BROKER_SYMBOL_CHUNK_SIZE)
    const metricQuery = chunk.map(encodeURIComponent).join(',')
    const marketDataQuery = chunk.map((symbol) => `equity=${encodeURIComponent(symbol)}`).join('&')
    const [metricsPayload, marketDataPayload] = await Promise.all([
      tastyRequest(env, `/market-metrics?symbols=${metricQuery}`),
      tastyRequest(env, `/market-data/by-type?${marketDataQuery}`),
    ])
    metrics.push(...strictTastytradeRows(metricsPayload, 'TastytradeMetrics'))
    quotes.push(...strictTastytradeRows(marketDataPayload, 'TastytradeMarketData'))
  }
  return { metrics, quotes }
}

async function readOptionalYearCandles(
  env: AppEnv,
  symbols: readonly string[],
): Promise<Map<string, number>> {
  if (!env.DB) return new Map()
  try {
    return await readYearAgoCloses(env.DB, symbols)
  } catch (cause) {
    // The missing chart is visible in the response; keep the live price path available while
    // recording only the failure class, never a provider or database body.
    console.error('YearCandleCacheReadFailed', cause instanceof Error ? cause.name : 'UnknownError')
    return new Map()
  }
}

async function loadMarketFacts(
  env: AppEnv,
  symbols: readonly string[],
): Promise<Pick<MarketSnapshot, 'catalysts' | 'tickers'>> {
  const [{ metrics, quotes }, instrumentCatalog] = await Promise.all([
    loadMarketRows(env, symbols),
    readInstrumentCatalog(env, symbols),
  ])
  const metricBySymbol = tastytradeRowsByRequestedSymbol(metrics, symbols, 'TastytradeMetrics')
  const quoteBySymbol = tastytradeRowsByRequestedSymbol(quotes, symbols, 'TastytradeMarketData')
  const normalized = symbols.flatMap((symbol) => {
    const metricsRow = metricBySymbol.get(symbol)
    const quoteRow = quoteBySymbol.get(symbol)
    const instrument = instrumentCatalog.get(symbol)
    if (!metricsRow || !quoteRow || !instrument) return []
    return [normalizeTastytradeMarketTicker(symbol, metricsRow, quoteRow, catalogTickerInstrument(instrument))]
  })
  // A symbol the provider or catalog could not answer for is left out of this build and keeps
  // its previous stored row. That is the product's best-effort contract, so the drop is counted
  // rather than hidden: a name that never normalizes shows up here long before a reader notices.
  if (normalized.length < symbols.length) {
    console.warn('MarketSymbolsDropped', symbols.length - normalized.length)
  }
  if (!normalized.length) throw new CallerVisibleError('TastytradeSnapshot:empty')
  // Read-only: the year series is refreshed on the schedule, so a symbol the refresh has not
  // reached yet simply carries no year chart rather than delaying the whole market read.
  const yearCandles = await readOptionalYearCandles(env, symbols)
  for (const item of normalized) {
    const cached = yearCandles.get(item.ticker.symbol)
    if (cached !== undefined) item.ticker.yearAgoClose = cached
  }
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
    BROKER_SYMBOL_CHUNK_SIZE,
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
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CallerVisibleError('InstrumentCatalog:invalid-offset')
  const symbols = await readInternalWatchlistCatalogCandidates(env)
  if (offset > symbols.length) throw new CallerVisibleError('InstrumentCatalog:invalid-offset')
  const chunk = symbols.slice(offset, offset + BROKER_SYMBOL_CHUNK_SIZE)
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

async function loadTastytradeWatchlistSeedPayloads(
  env: AppEnv,
  credential: BrokerCredential,
): Promise<InternalWatchlistSeedPayloads> {
  const [privatePayload, publicPayload] = await Promise.all([
    tastyRequest(env, '/watchlists', {}, credential),
    tastyRequest(env, '/public-watchlists', {}, credential),
  ])
  return { privatePayload, publicPayload }
}

export async function previewInternalWatchlistFromTastytrade(
  env: AppEnv,
  credential?: BrokerCredential,
): Promise<InternalWatchlistSeedPreview> {
  if (!credential) throw new BrokerCredentialMissingError()
  return previewInternalWatchlistSeed(await loadTastytradeWatchlistSeedPayloads(env, credential))
}

/** The only code path that reads tastytrade watchlists: the explicit one-time bootstrap Worker. */
export async function seedInternalWatchlistFromTastytrade(
  env: AppEnv,
  credential?: BrokerCredential,
): Promise<void> {
  if (!credential) throw new BrokerCredentialMissingError()
  await ensureInternalWatchlistSeeded(env, () => loadTastytradeWatchlistSeedPayloads(env, credential))
}

async function loadMarketSnapshot(env: AppEnv): Promise<MarketSnapshot> {
  const sessionPayload = await tastyRequest(env, '/market-time/equities/sessions/current')
  // Held names reach the watchlist through the trade-intent write at placement; snapshots no
  // longer read positions. Every write to the list already holds it to its cap in the same
  // batch, so this path only reads the focus. The one publish of the public universe is below,
  // after the build succeeds.
  const symbols = await readInternalWatchlistFocus(env, [], MAX_WATCHLIST_SYMBOLS)
  const privateWatchlist: Watchlist = {
    id: 'watchlist',
    kind: 'private',
    name: 'Watchlist',
    symbols,
  }
  const watchlists = [privateWatchlist]
  // New owner and agent symbols get an authoritative name immediately; a later market-open
  // snapshot retries the honest unresolved rows.
  await refreshMissingTastytradeInstruments(env, symbols)
  const { catalysts, tickers } = await loadMarketFacts(env, symbols)
  const session = await cacheProviderSession(env, sessionPayload)

  const syncedAt = new Date().toISOString()
  const snapshot = MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    ...session,
    watchlists,
    tickers,
    catalysts,
    brief: await loadStoredBrief(env),
  })
  await publishInternalWatchlistUniverse(env, new Date(syncedAt))
  return snapshot
}

/**
 * Resolve a symbol the loaded watchlist does not carry yet: the instrument catalog
 * answers first, an unknown ticker is put to the broker once, and whatever resolves is
 * admitted to the maintained list so the row keeps arriving with every later snapshot.
 * Account-free like the public snapshot around it — `position` is always false.
 */
async function lookupPublicMarketSymbol(
  env: AppEnv,
  query: string,
): Promise<PublicSymbolLookup | undefined> {
  const symbol = await resolveSearchedSymbol(env, query)
  if (!symbol) return undefined
  const retained = await ensureInternalWatchlistSymbols(env, [symbol], 'visitor-search')
  const facts = await loadMarketFacts(env, [symbol])
  const ticker = facts.tickers[0]
  if (!ticker) return undefined
  return {
    catalysts: facts.catalysts,
    ticker: publicTickerFromTicker(ticker),
    watchlisted: retained.includes(symbol),
  }
}

/**
 * The same lookup, answered from the store. Every successful live lookup persists its symbol
 * through `loadMarketFacts`, so a symbol anyone has already searched can be served again
 * without a provider call.
 */
async function catalogSymbolForQuery(
  env: AppEnv,
  query: string,
): Promise<{ candidate: string | undefined; symbol: string | undefined }> {
  const candidate = symbolCandidate(query)
  const [match] = await searchInstrumentCatalog(env, candidate ?? query, 1)
  // A stored fuzzy match cannot establish that an unchecked exact ticker is absent.
  if (candidate && match?.symbol !== candidate) return { candidate, symbol: undefined }
  return { candidate, symbol: match?.symbol }
}

async function lookupStoredMarketSymbol(
  env: AppEnv,
  query: string,
): Promise<PublicSymbolLookup | undefined> {
  if (!env.DB) return undefined
  const { symbol } = await catalogSymbolForQuery(env, query)
  if (!symbol) return undefined
  const [records, catalog, yearCandles, catalysts] = await Promise.all([
    readStoredMarketRecords(env, [symbol]),
    readInstrumentCatalog(env, [symbol]),
    readYearAgoCloses(env.DB, [symbol]),
    readUpcomingCatalysts(env),
  ])
  const quote = records.quotes.get(symbol)
  if (!quote) return undefined
  const ticker = tickerFromStoredRecords(
    symbol,
    records.metrics.get(symbol),
    quote,
    catalogTickerInstrument(catalog.get(symbol)),
    yearCandles.get(symbol),
  )
  return {
    catalysts: catalysts.filter((catalyst) => catalyst.symbol === symbol),
    ticker: publicTickerFromTicker(ticker),
    // A stored answer says nothing about maintained-list membership, which only the live
    // lookup decides; claiming otherwise would tell the reader their search was retained.
    watchlisted: false,
  }
}

async function resolveSearchedSymbol(env: AppEnv, query: string): Promise<string | undefined> {
  const { candidate, symbol } = await catalogSymbolForQuery(env, query)
  if (symbol || !candidate) return symbol
  // Prefixes and company names may match an unrelated ticker. Resolve the requested
  // ticker before allowing that weaker match to stand in for it.
  await refreshMissingTastytradeInstruments(env, [candidate])
  const { symbol: resolved } = await catalogSymbolForQuery(env, candidate)
  return resolved
}

/**
 * Account-free public surface. Its read-only watchlist universe is published by owner/server sync;
 * this path never calls account, position, or private-watchlist endpoints. `position` is always false.
 */
export async function loadPublicMarketSnapshot(
  env: AppEnv,
): Promise<PublicMarketSnapshot> {
  const storedUniverse = await loadStoredPublicMarketUniverse(env)
  const publicSymbols = [...new Set(storedUniverse.symbols)]
  const [sessionResult, marketFacts] = await Promise.all([
    tastyRequest(env, '/market-time/equities/sessions/current'),
    loadMarketFacts(env, publicSymbols),
  ])
  const syncedAt = new Date().toISOString()
  const session = await cacheProviderSession(env, sessionResult)
  const watchlists = [{
    id: 'public-options-watch',
    kind: 'public' as const,
    name: 'Options Watch',
    symbols: storedUniverse.symbols,
  }]
  return PublicMarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    ...session,
    watchlists,
    tickers: marketFacts.tickers.map(publicTickerFromTicker),
    catalysts: marketFacts.catalysts,
    brief: await loadStoredBrief(env),
  })
}

/** Session only: overnight `after` becomes `pre` without rebuilding quotes. */
async function refreshPublicMarketSession(
  env: AppEnv,
  snapshot: PublicMarketSnapshot,
): Promise<PublicMarketSnapshot> {
  const payload = await tastyRequest(env, '/market-time/equities/sessions/current')
  return { ...snapshot, ...await cacheProviderSession(env, payload) }
}

/**
 * Caching the session is best-effort: it is a read optimization for later visitors, never a
 * reason to fail the live build that already has the answer in hand.
 */
async function cacheProviderSession(env: AppEnv, payload: JsonValue, now = new Date()) {
  const session = {
    marketClosesAt: marketClosesAtFromTastytradeSession(payload, now),
    marketOpensAt: marketOpensAtFromTastytradeSession(payload, now),
    marketState: marketStateFromTastytradeSession(payload),
  }
  try {
    await persistMarketSession(env, session.marketState, session.marketOpensAt, session.marketClosesAt)
  } catch (error) {
    console.error('MarketSessionCacheWriteFailed', error instanceof Error ? error.name : 'UnknownError')
  }
  return session
}

/**
 * Everything a stored snapshot is assembled from, for one symbol list. Both audiences read the
 * same tables and build the same rows; only the symbol list, the watchlist descriptor and the
 * schema that parses the result differ, so the stored read model is derived in one place and a
 * fix to it cannot land on one audience and miss the other.
 */
async function storedSnapshotParts(env: AppEnv, symbols: readonly string[]) {
  if (!env.DB || !symbols.length) return undefined
  const [records, catalog, yearCandles, catalysts, session, brief] = await Promise.all([
    readStoredMarketRecords(env, symbols),
    readInstrumentCatalog(env, symbols),
    readYearAgoCloses(env.DB, symbols),
    readUpcomingCatalysts(env),
    readStoredMarketSession(env),
    loadStoredBrief(env),
  ])
  // A quote is what makes a row renderable; a symbol the store has never seen is left out
  // rather than shown at a price of zero.
  const tickers = symbols
    .map((symbol) => ({ quote: records.quotes.get(symbol), symbol }))
    .filter((entry): entry is { quote: TastytradeMarketQuoteRecord; symbol: string } => Boolean(entry.quote))
    .map(({ quote, symbol }) => tickerFromStoredRecords(
      symbol,
      records.metrics.get(symbol),
      quote,
      catalogTickerInstrument(catalog.get(symbol)),
      yearCandles.get(symbol),
    ))
  if (!tickers.length || !records.observedAt || !records.latestObservedAt) return undefined
  return {
    brief,
    catalysts,
    latestObservedAt: records.latestObservedAt,
    observedAt: records.observedAt,
    session,
    tickers,
  }
}

/**
 * A public snapshot read from the store, with the instant the store was last written for it.
 * The snapshot's own `syncedAt` is the oldest reading, the honest staleness bound a reader sees;
 * `lastWrittenAt` is the newest, which is what says whether the provider was asked lately. It
 * stays beside the snapshot rather than in it, because the snapshot is the public wire contract.
 */
export type StoredPublicMarketSnapshot = {
  lastWrittenAt: string
  snapshot: PublicMarketSnapshot
}

/**
 * Build the public snapshot entirely from the store, so an ordinary visitor never causes a
 * provider request. Absence is returned rather than thrown: a cold store has nothing to serve
 * and the caller falls back to one guarded live build.
 */
async function loadStoredPublicMarketSnapshot(env: AppEnv): Promise<StoredPublicMarketSnapshot | undefined> {
  if (!env.DB) return undefined
  const storedUniverse = await loadStoredPublicMarketUniverse(env)
  const parts = await storedSnapshotParts(env, [...new Set(storedUniverse.symbols)])
  if (!parts) return undefined
  const snapshot = PublicMarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt: parts.observedAt,
    marketState: parts.session?.state ?? 'unknown',
    marketOpensAt: parts.session?.opensAt,
    marketClosesAt: parts.session?.closesAt,
    watchlists: [{
      id: 'public-options-watch',
      kind: 'public' as const,
      name: 'Options Watch',
      symbols: storedUniverse.symbols,
    }],
    tickers: parts.tickers.map(publicTickerFromTicker),
    catalysts: parts.catalysts,
    brief: parts.brief,
  })
  return { lastWrittenAt: parts.latestObservedAt, snapshot }
}

/**
 * The owner's default view, served entirely from the market store. The legacy `position` field
 * is now always false and is scheduled for removal.
 */
async function loadStoredMarketSnapshot(env: AppEnv): Promise<MarketSnapshot | undefined> {
  if (!env.DB) return undefined
  const focusSymbols = await readInternalWatchlistFocus(env, [], MAX_WATCHLIST_SYMBOLS)
  const parts = await storedSnapshotParts(env, focusSymbols)
  if (!parts) return undefined
  return MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt: parts.observedAt,
    marketState: parts.session?.state ?? 'unknown',
    marketOpensAt: parts.session?.opensAt,
    marketClosesAt: parts.session?.closesAt,
    watchlists: [{ id: 'watchlist', kind: 'private' as const, name: 'Watchlist', symbols: focusSymbols }],
    tickers: parts.tickers,
    catalysts: parts.catalysts,
    brief: parts.brief,
  })
}

/**
 * The slice of the Tastytrade API that the rest of the server reaches for. Production
 * code calls it through `brokerApi()` so a test can install a faithful in-memory broker
 * with `setBrokerApi` instead of replacing this module. Each entry is the
 * implementation above, so the contract type cannot drift from the real signatures.
 */
const brokerApiSeam = defineSeam(() => ({
  loadMarketSnapshot,
  loadPublicMarketSnapshot,
  claimMarketRefresh,
  loadStoredMarketSnapshot,
  loadStoredPublicMarketSnapshot,
  lookupPublicMarketSymbol,
  lookupStoredMarketSymbol,
  loadQuoteToken,
  refreshPublicMarketSession,
  resolveAccountNumber,
  tastyRequest,
  withBrokerMutationLease,
}))

export type BrokerApi = SeamValue<typeof brokerApiSeam>

export const brokerApi = brokerApiSeam.current

export const setBrokerApi = brokerApiSeam.set

export const resetBrokerApi = brokerApiSeam.reset
