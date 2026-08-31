import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import {
  MarketSnapshotSchema,
  PublicMarketSnapshotSchema,
  type MarketSnapshot,
  type PublicMarketSnapshot,
  type Watchlist,
  publicTickerFromTicker,
} from '../domain/market'
import { type AppEnv } from './env'
import { readBoundedJson } from './bounded-response'
import { catalystsFromMarketMetrics, persistAndLoadCatalysts } from './catalysts'
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
  jsonObject,
  jsonObjectOrEmpty,
  jsonText,
  type JsonValue,
} from '../domain/json-payload'
import { readStoredSecret } from './secrets'
import {
  instrumentCatalogSymbolsNeedingResolution,
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
  activeEquityPositionSymbols,
  catalogTickerInstrument,
  equityCandleFromTime,
  liveTickerFromRecords,
  marketStateFromTastytradeSession,
  normalizeTastytradeMarketTicker,
  selectSnapshotSymbols,
  strictTastytradeRows,
  tastytradeRowsByRequestedSymbol,
} from './tastytrade-market-normalization'
import { defineSeam, type SeamValue } from './seam'
import { loadStoredPublicMarketUniverse, publishInternalWatchlistUniverse } from './public-market-universe'
import { readLatestResearchBrief } from './research-brief-store'

export { equityCandleFromTime, liveTickerFromRecords, selectSnapshotSymbols }

const USER_AGENT = 'Spice/0.1'
// Provider JSON is buffered for strict parsing; stay within the Worker isolate memory budget
// while allowing the catalog endpoints, which are substantially larger than normal reads.
const MAX_TASTYTRADE_RESPONSE_BYTES = 16 * 1024 * 1024
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

async function loadEquityCandleFromTime(env: AppEnv): Promise<number> {
  return equityCandleFromTime(await tastyRequest(env, '/market-time/equities/sessions/current'))
}

async function loadStoredResearch(env: AppEnv): Promise<MarketSnapshot['research']> {
  if (!env.DB) throw new Error('TastytradeResearch:store-unavailable')
  return readLatestResearchBrief(env.DB)
}

type MarketSnapshotOptions = {
  symbols?: readonly string[]
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
  const metrics = strictTastytradeRows(metricsPayload, 'TastytradeMetrics')
  const quotes = strictTastytradeRows(marketDataPayload, 'TastytradeMarketData')
  const metricBySymbol = tastytradeRowsByRequestedSymbol(metrics, symbols, 'TastytradeMetrics')
  const quoteBySymbol = tastytradeRowsByRequestedSymbol(quotes, symbols, 'TastytradeMarketData')
  if (instrumentCatalog.size !== symbols.length) throw new Error('InstrumentCatalog:incomplete')
  const normalized = symbols.map((symbol) => normalizeTastytradeMarketTicker(
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

export async function resolveResearchInstrumentCatalogFromTastytrade(
  env: AppEnv,
  now = new Date(),
): Promise<InstrumentCatalogRefresh> {
  const symbols = (await readInternalWatchlist(env)).map((item) => item.symbol)
  const unresolved = await instrumentCatalogSymbolsNeedingResolution(env, symbols)
  return refreshTastytradeInstrumentCatalog(env, unresolved, now)
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

/** Fetch position identity before the one-time D1 finalization mutates live rows. */
export async function loadOwnerPositionSymbolsFromTastytrade(env: AppEnv): Promise<string[]> {
  const accountNumber = await resolveAccountNumber(env)
  const payload = await tastyRequest(env, `/accounts/${encodeURIComponent(accountNumber)}/positions`)
  return activeEquityPositionSymbols(strictTastytradeRows(payload, 'TastytradePositions'))
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
  const positions = strictTastytradeRows(positionPayload, 'TastytradePositions')
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
  // immediately. A market-open research run retries the honest unresolved rows.
  await refreshMissingTastytradeInstruments(env, symbols)
  const { catalysts, tickers } = await loadMarketFacts(env, symbols, new Set(positionSymbols))
  const marketState = marketStateFromTastytradeSession(sessionPayload)

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
): Promise<PublicMarketSnapshot> {
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
  return PublicMarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    marketState: marketStateFromTastytradeSession(sessionResult),
    watchlists,
    tickers: marketFacts.tickers.map(publicTickerFromTicker),
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
  resolveResearchInstrumentCatalogFromTastytrade,
  resolveAccountNumber,
  tastyRequest,
  withBrokerMutationLease,
}))

export type BrokerApi = SeamValue<typeof brokerApiSeam>

export const brokerApi = brokerApiSeam.current

export const setBrokerApi = brokerApiSeam.set

export const resetBrokerApi = brokerApiSeam.reset
