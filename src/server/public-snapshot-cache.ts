import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic, PUBLIC_RESPONSE_CACHE_CONTROL } from './http'
import { brokerApi } from './tastytrade'

const SNAPSHOT_FRESH_MS = 60 * 1_000
const SNAPSHOT_MAX_STALE_MS = 10 * 60 * 1_000
const SNAPSHOT_RETENTION_SECONDS = 15 * 60
export const SNAPSHOT_GENERATED_AT_HEADER = 'X-Snapshot-Generated-At'

/** The only two Cache API methods this module needs, so tests can pass an in-memory copy. */
export type PublicSnapshotCache = Pick<Cache, 'match' | 'put'>

// A module-level promise coalesces background refreshes within one isolate. Other isolates may
// still refresh at the same time, which is acceptable: the retained copy is colo-local too, so
// there is no shared state to coordinate through and the worst case is a few extra broker reads.
let refreshInFlight: Promise<void> | undefined

function cacheKeyFor(request: Request): Request {
  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  // Version the private Cache API key so a deploy cannot serve a response
  // serialized under an older public privacy contract.
  cacheUrl.searchParams.set('schema', '3')
  cacheUrl.searchParams.set('copy', 'last-good')
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
  return response
}

async function buildAndStore(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
): Promise<Response> {
  const snapshot = await brokerApi().loadPublicMarketSnapshot(env)
  const response = jsonPublic(snapshot, {
    headers: { [SNAPSHOT_GENERATED_AT_HEADER]: new Date().toISOString() },
  })
  const stored = response.clone()
  // This header governs only the distinct Cache API copy. Responses served to visitors are
  // rewritten to jsonPublic's policy, and the extra retention lets us enforce the 10-minute
  // maximum ourselves instead of losing the last good copy at its 60-second freshness edge.
  stored.headers.set('Cache-Control', `public, max-age=${SNAPSHOT_RETENTION_SECONDS}`)
  // A rejected put must not turn a good snapshot into an error for the waiting visitor.
  await edgeCache.put(cacheKey, stored).catch(() => undefined)
  return response
}

async function refreshStoredSnapshot(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
): Promise<void> {
  try {
    await buildAndStore(env, edgeCache, cacheKey)
  } catch (error) {
    console.error('PublicMarketSnapshotRefreshFailed', error instanceof Error ? error.message : 'UnknownError')
  } finally {
    refreshInFlight = undefined
  }
}

export async function servePublicSnapshot(
  request: Request,
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  schedule: (task: Promise<void>) => void,
  now = Date.now(),
): Promise<Response> {
  const cacheKey = cacheKeyFor(request)
  const stored = await edgeCache.match(cacheKey).catch(() => undefined)
  if (stored) {
    const age = storedAgeMs(stored, now)
    if (age < SNAPSHOT_FRESH_MS) return responseForVisitor(stored)
    // Ten minutes is the hard trust bound: beyond it, waiting for current data is safer
    // than showing a snapshot that may be hours old after an upstream outage.
    if (age <= SNAPSHOT_MAX_STALE_MS) {
      if (!refreshInFlight) {
        refreshInFlight = refreshStoredSnapshot(env, edgeCache, cacheKey)
        schedule(refreshInFlight)
      }
      return responseForVisitor(stored)
    }
  }

  try {
    return await buildAndStore(env, edgeCache, cacheKey)
  } catch (error) {
    console.error('PublicMarketSnapshotUnavailable', error instanceof Error ? error.message : 'UnknownError')
    return jsonNoStore({ error: 'Public market sync is temporarily unavailable' }, { status: 502 })
  }
}
