import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic, PUBLIC_RESPONSE_CACHE_CONTROL } from './http'
import { brokerApi } from './tastytrade'

// A cached provider snapshot is usable for one minute. Older data is never served.
const SNAPSHOT_FRESH_MS = 60 * 1_000
const SNAPSHOT_RETENTION_SECONDS = 60
export const SNAPSHOT_GENERATED_AT_HEADER = 'X-Snapshot-Generated-At'

/** The only two Cache API methods this module needs, so tests can pass an in-memory copy. */
export type PublicSnapshotCache = Pick<Cache, 'match' | 'put'>

function cacheKeyFor(request: Request): Request {
  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  // Version the private Cache API key so a deploy cannot serve a response
  // serialized under an older public privacy contract.
  cacheUrl.searchParams.set('schema', '3')
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
    return await buildAndStore(env, edgeCache, cacheKey)
  } catch (error) {
    console.error('PublicMarketSnapshotUnavailable', error instanceof Error ? error.message : 'UnknownError')
    return jsonNoStore({ error: 'Public market sync is temporarily unavailable' }, { status: 502 })
  }
}
