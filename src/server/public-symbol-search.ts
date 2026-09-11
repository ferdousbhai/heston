import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic } from './http'
import { type PublicSnapshotCache } from './public-snapshot-cache'
import { searchableQuery } from './symbol-search'
import { SYMBOL_REFRESH_LEASE_PREFIX } from './tastytrade-market-store'
import { brokerApi } from './tastytrade'

/**
 * A lookup costs a broker read and a maintained-list write, so an answer is kept and
 * replayed: the same search repeated by any number of readers resolves once a minute.
 * A search that matched nothing is kept longer — a typo does not become a symbol.
 */
const FOUND_RETENTION_SECONDS = 60
const MISSING_RETENTION_SECONDS = 300
// One lookup per symbol may reach the provider at a time. The edge copy only dedupes readers
// that land in the same location, so the claim is what stops the same search in twenty places
// from becoming twenty provider calls.
const LOOKUP_LEASE_MS = 30 * 1_000

function cacheKeyFor(request: Request, query: string): Request {
  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  cacheUrl.searchParams.set('schema', '1')
  cacheUrl.searchParams.set('q', query)
  return new Request(cacheUrl, { method: 'GET' })
}

async function store(
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  response: Response,
  retentionSeconds: number,
): Promise<Response> {
  const stored = response.clone()
  stored.headers.set('Cache-Control', `public, max-age=${retentionSeconds}`)
  try {
    await edgeCache.put(cacheKey, stored)
  } catch (error) {
    console.error('PublicSymbolSearchCacheWriteFailed', error instanceof Error ? error.message : 'UnknownError')
  }
  return response
}

export async function servePublicSymbolSearch(
  request: Request,
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
): Promise<Response> {
  const query = searchableQuery(new URL(request.url).searchParams.get('q') ?? '')
  if (!query) return jsonNoStore({ error: 'Search for a symbol or a company name' }, { status: 400 })
  const cacheKey = cacheKeyFor(request, query)
  try {
    const stored = await edgeCache.match(cacheKey)
    if (stored) return stored
  } catch (error) {
    console.error('PublicSymbolSearchCacheReadFailed', error instanceof Error ? error.message : 'UnknownError')
  }

  try {
    // A symbol anyone has already searched is in the store, so losing the claim still answers.
    const stored = await brokerApi().lookupStoredMarketSymbol(env, query)
      .catch(() => undefined)
    const claimed = await brokerApi().claimMarketRefresh(env, LOOKUP_LEASE_MS, new Date(), `${SYMBOL_REFRESH_LEASE_PREFIX}${query}`)
    if (!claimed && stored) return await store(edgeCache, cacheKey, jsonPublic(stored), FOUND_RETENTION_SECONDS)
    const lookup = await brokerApi().lookupPublicMarketSymbol(env, query)
    if (!lookup) {
      return await store(
        edgeCache,
        cacheKey,
        jsonPublic({ error: 'No tradable symbol matches that search' }, { status: 404 }),
        MISSING_RETENTION_SECONDS,
      )
    }
    return await store(edgeCache, cacheKey, jsonPublic(lookup), FOUND_RETENTION_SECONDS)
  } catch (error) {
    console.error('PublicSymbolSearchUnavailable', error instanceof Error ? error.message : 'UnknownError')
    const stored = await brokerApi().lookupStoredMarketSymbol(env, query).catch(() => undefined)
    if (stored) return jsonPublic(stored)
    return jsonNoStore({ error: 'Symbol search is temporarily unavailable' }, { status: 503 })
  }
}
