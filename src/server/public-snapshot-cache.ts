import { type PublicMarketSnapshot } from '../domain/market'
import { SPICE_DEPLOYMENT_ID } from '../deployment'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../domain/deployment'
import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic, PUBLIC_RESPONSE_CACHE_CONTROL } from './http'
import { brokerApi } from './tastytrade'

// A cached provider snapshot is usable for one minute before a refresh is attempted.
const SNAPSHOT_FRESH_MS = 60 * 1_000
// How long one refresh may hold the exclusive claim before another caller may retry it. Long
// enough to cover a slow provider, short enough that a crashed refresh unblocks quickly.
const REFRESH_LEASE_MS = 30 * 1_000
// Only reached on a cold store, where the alternative is every concurrent visitor rebuilding
// from the provider at once. Two short waits, then honest unavailability.
const COLD_STORE_RETRY_DELAYS_MS = [1_000, 2_000]
const SNAPSHOT_RETENTION_SECONDS = 60
export const SNAPSHOT_GENERATED_AT_HEADER = 'X-Snapshot-Generated-At'

/** The only two Cache API methods this module needs, so tests can pass an in-memory copy. */
export type PublicSnapshotCache = Pick<Cache, 'match' | 'put'>

function cacheKeyFor(request: Request): Request {
  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  // Scope the private Cache API copy to the code that serialized it. The request's
  // query remains untrusted and is discarded, so visitors cannot create cache shards.
  cacheUrl.searchParams.set('schema', '4')
  cacheUrl.searchParams.set('deployment', SPICE_DEPLOYMENT_ID)
  cacheUrl.searchParams.set('copy', 'fresh')
  return new Request(cacheUrl, { method: 'GET' })
}

function storedAgeMs(stored: Response, now: number): number {
  const generatedAt = stored.headers.get(SNAPSHOT_GENERATED_AT_HEADER)
  const generatedTime = generatedAt ? Date.parse(generatedAt) : Number.NaN
  // An unlabeled or unparseable copy counts as infinitely old, so it is rebuilt rather than served.
  if (Number.isNaN(generatedTime)) return Number.POSITIVE_INFINITY
  return now - generatedTime
}

function responseForVisitor(stored: Response): Response {
  // Cache API headers are immutable, so the retention policy is swapped out on a fresh response.
  const response = new Response(stored.body, stored)
  response.headers.set('Cache-Control', PUBLIC_RESPONSE_CACHE_CONTROL)
  // The body contract is schema-versioned in the Cache API key, but this header describes
  // the Worker serving it now. Never leak the deployment id retained with an older copy.
  response.headers.set(SPICE_DEPLOYMENT_ID_HEADER, SPICE_DEPLOYMENT_ID)
  return response
}

/**
 * The visitor path reads the store; only the one caller that wins the refresh claim may reach
 * the provider. Everyone else is served the stored copy, however old, because a stale price
 * with an honest `syncedAt` is worth more to a reader than a 502 — and because letting each
 * visitor refresh is exactly the fan-out this exists to prevent.
 */
async function publicSnapshot(env: AppEnv, now: number): Promise<PublicMarketSnapshot> {
  const stored = await brokerApi().loadStoredPublicMarketSnapshot(env)
  if (stored && now - Date.parse(stored.syncedAt) < SNAPSHOT_FRESH_MS) return stored
  const claimed = await brokerApi().claimMarketRefresh(env, REFRESH_LEASE_MS)
  if (!claimed) {
    // A loser with something stored serves it. A loser with nothing — a cold store, so every
    // concurrent visitor is in this branch at once — waits for the winner's write instead of
    // falling through to the provider, which would be the exact fan-out the claim prevents.
    if (stored) return stored
    const filled = await awaitFirstRefresh(env)
    if (filled) return filled
    throw new Error('PublicMarketSnapshot:store-cold')
  }
  try {
    return await brokerApi().loadPublicMarketSnapshot(env)
  } catch (error) {
    if (!stored) throw error
    console.error('PublicMarketSnapshotRefreshFailed', error instanceof Error ? error.message : 'UnknownError')
    return stored
  }
}

/** Give the one caller that won the claim time to land the first write, then read it. */
async function awaitFirstRefresh(env: AppEnv): Promise<PublicMarketSnapshot | undefined> {
  for (const delay of COLD_STORE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    const stored = await brokerApi().loadStoredPublicMarketSnapshot(env)
    if (stored) return stored
  }
  return undefined
}

async function buildAndStore(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  now: number,
): Promise<Response> {
  const snapshot = await publicSnapshot(env, now)
  const response = jsonPublic(snapshot, {
    headers: { [SNAPSHOT_GENERATED_AT_HEADER]: snapshot.syncedAt },
  })
  const stored = response.clone()
  // This header governs only the distinct Cache API copy. Visitor cache policy is restored
  // by responseForVisitor.
  stored.headers.set('Cache-Control', `public, max-age=${SNAPSHOT_RETENTION_SECONDS}`)
  try {
    await edgeCache.put(cacheKey, stored)
  } catch (error) {
    console.error('PublicMarketSnapshotCacheWriteFailed', error instanceof Error ? error.message : 'UnknownError')
  }
  return response
}

export async function servePublicSnapshot(
  request: Request,
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  now = Date.now(),
): Promise<Response> {
  const cacheKey = cacheKeyFor(request)
  let stored: Response | undefined
  try {
    stored = await edgeCache.match(cacheKey)
  } catch (error) {
    console.error('PublicMarketSnapshotCacheReadFailed', error instanceof Error ? error.message : 'UnknownError')
  }
  if (stored) {
    const age = storedAgeMs(stored, now)
    if (age < SNAPSHOT_FRESH_MS) return responseForVisitor(stored)
  }

  try {
    return await buildAndStore(env, edgeCache, cacheKey, now)
  } catch (error) {
    console.error('PublicMarketSnapshotUnavailable', error instanceof Error ? error.message : 'UnknownError')
    return jsonNoStore({ error: 'Public market sync is temporarily unavailable' }, { status: 502 })
  }
}
