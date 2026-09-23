import { type PublicSymbolLookup } from '../domain/market'
import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic } from './http'
import { COLD_STORE_RETRY_DELAYS_MS, type PublicSnapshotCache } from './public-snapshot-cache'
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
// from becoming twenty provider calls. The lease bounds a holder that dies mid-lookup; one that
// finishes gives its claim back, because a search that matched nothing is kept only in the
// holder's own location, and a reader elsewhere must be able to ask rather than be told "busy"
// for the rest of a lease that guards nothing.
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
    console.error('PublicSymbolSearchCacheWriteFailed', error instanceof Error ? error.name : 'UnknownError')
  }
  return response
}

async function readStored(env: AppEnv, query: string): Promise<PublicSymbolLookup | undefined> {
  try {
    return await brokerApi().lookupStoredMarketSymbol(env, query)
  } catch (error) {
    console.error('PublicSymbolSearchStoreReadFailed', error instanceof Error ? error.name : 'UnknownError')
    return undefined
  }
}

/** Claim the one provider lookup for this query, answering the claim's instant when it is ours. */
async function claimLookup(env: AppEnv, leaseId: string): Promise<Date | undefined> {
  const claimedAt = new Date()
  return await brokerApi().claimMarketRefresh(env, LOOKUP_LEASE_MS, claimedAt, leaseId) ? claimedAt : undefined
}

/** The provider lookup, made only while holding the claim, which is released however it ends. */
async function lookupHoldingClaim(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  query: string,
  leaseId: string,
  claimedAt: Date,
): Promise<Response> {
  try {
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
  } finally {
    await brokerApi().releaseMarketRefresh(env, LOOKUP_LEASE_MS, claimedAt, leaseId)
  }
}

/**
 * Give the one caller that won the claim time to land its answer, then read it: the edge copy
 * first, which also carries a search that matched nothing, then the store, which a winner in
 * another location writes. A winner whose answer reached neither -- a search that matched
 * nothing, answered in another location -- has released its claim by then, so claiming again
 * takes over the lookup rather than reporting busy; the claim still admits one lookup at a time.
 */
async function awaitClaimWinner(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  query: string,
  leaseId: string,
): Promise<Response | undefined> {
  for (const delay of COLD_STORE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      const cached = await edgeCache.match(cacheKey)
      if (cached) return cached
    } catch (error) {
      console.error('PublicSymbolSearchCacheReadFailed', error instanceof Error ? error.name : 'UnknownError')
    }
    const stored = await readStored(env, query)
    if (stored) return await store(edgeCache, cacheKey, jsonPublic(stored), FOUND_RETENTION_SECONDS)
    const claimedAt = await claimLookup(env, leaseId)
    if (claimedAt) return await lookupHoldingClaim(env, edgeCache, cacheKey, query, leaseId, claimedAt)
  }
  return undefined
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
    console.error('PublicSymbolSearchCacheReadFailed', error instanceof Error ? error.name : 'UnknownError')
  }

  // A symbol anyone has already searched is in the store, so losing the claim still answers, and
  // so does a live lookup that fails. Read once: the failure path reuses this answer.
  const stored = await readStored(env, query)
  const leaseId = `${SYMBOL_REFRESH_LEASE_PREFIX}${query}`
  try {
    const claimedAt = await claimLookup(env, leaseId)
    if (claimedAt) return await lookupHoldingClaim(env, edgeCache, cacheKey, query, leaseId, claimedAt)
    if (stored) return await store(edgeCache, cacheKey, jsonPublic(stored), FOUND_RETENTION_SECONDS)
    // A first-time search whose claim another caller holds waits for that caller's answer
    // rather than making its own provider call, which is the fan-out the claim exists to stop.
    const awaited = await awaitClaimWinner(env, edgeCache, cacheKey, query, leaseId)
    if (awaited) return awaited
    return jsonNoStore({ error: 'Symbol search is busy; try again' }, { status: 503 })
  } catch (error) {
    console.error('PublicSymbolSearchUnavailable', error instanceof Error ? error.name : 'UnknownError')
    if (stored) return jsonPublic(stored)
    return jsonNoStore({ error: 'Symbol search is temporarily unavailable' }, { status: 503 })
  }
}
