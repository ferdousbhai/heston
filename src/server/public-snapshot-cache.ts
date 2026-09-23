import {
  slimPublicSnapshot,
  type MarketSnapshot,
  type PublicMarketSnapshot,
} from '../domain/market'
import { HESTON_DEPLOYMENT_ID } from '../deployment'
import { HESTON_DEPLOYMENT_ID_HEADER } from '../domain/deployment'
import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic, PUBLIC_RESPONSE_CACHE_CONTROL } from './http'
import { brokerApi, type StoredPublicMarketSnapshot } from './tastytrade'
import { CallerVisibleError } from './caller-visible-error'

// A provider reading is usable for one minute while the market is open before a refresh is
// attempted; the retained copy of the store is rebuilt on the same bound, since catalysts,
// the brief and searched-in symbols reach it through the store at any hour.
const SNAPSHOT_FRESH_MS = 60 * 1_000
// How long one refresh may hold the exclusive claim before another caller may retry it. Long
// enough to cover a slow provider, short enough that a crashed refresh unblocks quickly.
const REFRESH_LEASE_MS = 30 * 1_000
// Only reached on a cold store, where the alternative is every concurrent visitor rebuilding
// from the provider at once. Two short waits, then honest unavailability.
const COLD_STORE_RETRY_DELAYS_MS = [1_000, 2_000]
// A stale copy is served while the refresh behind it runs, so the copy must outlive its own
// fresh window by the time one refresh may take. Anything older is rebuilt in the reader's
// path from the store, which is cheap; only the provider is ever kept off that path.
const SNAPSHOT_RETENTION_SECONDS = (SNAPSHOT_FRESH_MS + REFRESH_LEASE_MS) / 1_000
/** The provider's own observation instant, as the snapshot body also reports it. */
export const SNAPSHOT_GENERATED_AT_HEADER = 'X-Snapshot-Generated-At'
/**
 * When this copy was built from the store. Distinct from the provider instant above: outside
 * market hours the provider reading is deliberately left to age, and a copy's own age is what
 * says whether the store has been re-read for it lately.
 */
export const SNAPSHOT_CACHED_AT_HEADER = 'X-Snapshot-Cached-At'

/** How far before the named open we will ask the provider for session state only. */
export const PRE_SESSION_REFRESH_MS = 6 * 60 * 60 * 1_000
/** Closed quotes older than this get one catch-up rebuild so a missed cash session does not stick. */
export const QUOTE_CATCH_UP_MS = 6 * 60 * 60 * 1_000

/**
 * A weak validator over the whole snapshot. Quotes, session, catalysts and the brief are
 * independent writes, and keying on any one instant hid the others behind 304s: a stored
 * snapshot's `syncedAt` is its oldest reading, so one symbol the provider stopped answering for
 * froze the tag while every other price moved. Hashing the content changes the tag exactly when
 * the answer changes. cyrb53 is a non-cryptographic 53-bit hash; a validator needs only to tell
 * two answers apart, and a collision costs one reader one stale revalidation.
 */
export function snapshotEtag(snapshot: MarketSnapshot | PublicMarketSnapshot): string {
  const text = JSON.stringify(snapshot)
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    h1 = Math.imul(h1 ^ code, 2_654_435_761)
    h2 = Math.imul(h2 ^ code, 1_597_334_677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2_246_822_507) ^ Math.imul(h2 ^ (h2 >>> 13), 3_266_489_909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2_246_822_507) ^ Math.imul(h1 ^ (h1 >>> 13), 3_266_489_909)
  const hash = 4_294_967_296 * (2_097_151 & h2) + (h1 >>> 0)
  return `W/"${hash.toString(36)}"`
}

function notModified(request: Request, stored: Response): Response | undefined {
  const etag = stored.headers.get('ETag')
  const inm = request.headers.get('If-None-Match')
  if (!etag || !inm) return undefined
  const tags = inm.split(',').map((part) => part.trim())
  if (!tags.includes(etag) && !tags.includes('*')) return undefined
  const headers = new Headers()
  headers.set('Cache-Control', PUBLIC_RESPONSE_CACHE_CONTROL)
  headers.set('ETag', etag)
  headers.set(HESTON_DEPLOYMENT_ID_HEADER, HESTON_DEPLOYMENT_ID)
  for (const name of [SNAPSHOT_CACHED_AT_HEADER, SNAPSHOT_GENERATED_AT_HEADER]) {
    const value = stored.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(null, { headers, status: 304 })
}

/** The only two Cache API methods this module needs, so tests can pass an in-memory copy. */
export type PublicSnapshotCache = Pick<Cache, 'match' | 'put'>

/**
 * Runs work past the end of the response, as `waitUntil` does. Passed in rather than imported
 * so a test can hold the refresh and assert on what it did.
 */
export type BackgroundScheduler = (task: Promise<unknown>) => void

function cacheKeyFor(request: Request): Request {
  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  // Scope the private Cache API copy to the code that serialized it. The request's
  // query remains untrusted and is discarded, so visitors cannot create cache shards.
  cacheUrl.searchParams.set('schema', '6')
  cacheUrl.searchParams.set('deployment', HESTON_DEPLOYMENT_ID)
  cacheUrl.searchParams.set('copy', 'fresh')
  return new Request(cacheUrl, { method: 'GET' })
}

function copyAgeMs(stored: Response, now: number): number {
  const cachedAt = stored.headers.get(SNAPSHOT_CACHED_AT_HEADER)
  const cachedTime = cachedAt ? Date.parse(cachedAt) : Number.NaN
  // An unlabeled or unparseable copy counts as infinitely old, so it is rebuilt rather than served.
  if (Number.isNaN(cachedTime)) return Number.POSITIVE_INFINITY
  return now - cachedTime
}

/**
 * Whether the provider reading behind a stored snapshot is worth refreshing now. Age is measured
 * from the store's last write, not from the snapshot's `syncedAt`: that is the oldest row, and a
 * symbol the provider stopped answering for would otherwise keep every reader's refresh due —
 * a provider rebuild a minute, all night, that could never repair the row that caused it.
 *
 * While the market is open, prices move and the one-minute bound applies. Outside the session
 * nothing trades, so the reading stands until the bell the provider itself named; refreshing
 * every minute through a night or a weekend spent a full provider round trip per visitor to
 * reproduce the same numbers. A session the store never labelled, or whose named open has
 * already passed, is refreshed on the open-market bound, so an unlabelled store can only err
 * toward asking.
 */
export function providerRefreshDue(stored: StoredPublicMarketSnapshot, now: number): boolean {
  const { snapshot } = stored
  if (now - Date.parse(stored.lastWrittenAt) < SNAPSHOT_FRESH_MS) return false
  if (snapshot.marketState === 'open' || snapshot.marketState === 'unknown') return true
  // A store written before the provider's metrics instant was kept has no age to show for any
  // reading, and a closed market would leave it that way until the next bell. One refresh
  // repairs every row, so it is bought on the open-market bound. Bounded to a store where no
  // row carries the instant: a provider that dates most rows and not some is not asked again.
  if (snapshot.tickers.length && snapshot.tickers.every((ticker) => ticker.metricsUpdatedAt === undefined)) return true
  // A named open that already rang is a stale session, not a reason to rebuild quotes. The
  // session-only path retags the bell; quotes wait until the session itself is open.
  return snapshot.marketOpensAt === undefined && snapshot.marketState === 'closed'
}

/** A closed book whose last quote predates the previous cash session still needs one rebuild. */
export function quoteCatchUpDue(stored: StoredPublicMarketSnapshot, now: number): boolean {
  if (stored.snapshot.marketState !== 'closed') return false
  const written = Date.parse(stored.lastWrittenAt)
  return Number.isFinite(written) && now - written >= QUOTE_CATCH_UP_MS
}

/** Overnight `after` becomes `pre` without a quote rebuild, starting six hours before the bell. */
export function sessionRefreshDue(
  snapshot: Pick<PublicMarketSnapshot, 'marketOpensAt' | 'marketState'>,
  now: number,
): boolean {
  if (snapshot.marketState === 'open' || snapshot.marketState === 'unknown') return false
  const opens = snapshot.marketOpensAt ? Date.parse(snapshot.marketOpensAt) : Number.NaN
  if (!Number.isFinite(opens)) return false
  // The named bell already rang and we are still not open: Friday's open sitting on a
  // Saturday, or a failed cash-open quote rebuild that never retagged the session.
  if (now >= opens) return true
  if (snapshot.marketState !== 'after') return false
  return opens - now <= PRE_SESSION_REFRESH_MS
}

/** A quote rebuild from the provider: the open-market bound, or a closed book's catch-up. */
function quoteRefreshDue(stored: StoredPublicMarketSnapshot, now: number): boolean {
  return providerRefreshDue(stored, now) || quoteCatchUpDue(stored, now)
}

/**
 * Whether a stored snapshot warrants any background refresh — quotes or the session. Both reader
 * paths decide with this one predicate; the cache-miss path used to leave out the closed-book
 * catch-up, so a store read there never scheduled the rebuild a stale-copy read would have.
 */
export function refreshDue(stored: StoredPublicMarketSnapshot, now: number): boolean {
  return quoteRefreshDue(stored, now) || sessionRefreshDue(stored.snapshot, now)
}

function responseForVisitor(stored: Response): Response {
  // Cache API headers are immutable, so the retention policy is swapped out on a fresh response.
  const response = new Response(stored.body, stored)
  response.headers.set('Cache-Control', PUBLIC_RESPONSE_CACHE_CONTROL)
  // The body contract is schema-versioned in the Cache API key, but this header describes
  // the Worker serving it now. Never leak the deployment id retained with an older copy.
  response.headers.set(HESTON_DEPLOYMENT_ID_HEADER, HESTON_DEPLOYMENT_ID)
  return response
}

/**
 * One provider rebuild, if this caller wins the claim. A lost claim or a failed build both
 * answer with nothing: the caller keeps serving what the store already holds, and the winner's
 * write reaches it on the next store read.
 */
async function refreshFromProvider(env: AppEnv): Promise<PublicMarketSnapshot | undefined> {
  const claimed = await brokerApi().claimMarketRefresh(env, REFRESH_LEASE_MS)
  if (!claimed) return undefined
  try {
    return await brokerApi().loadPublicMarketSnapshot(env)
  } catch (error) {
    console.error('PublicMarketSnapshotRefreshFailed', error instanceof Error ? error.name : 'UnknownError')
    return undefined
  }
}

/** Give the one caller that won the claim time to land the first write, then read it. */
async function awaitFirstRefresh(env: AppEnv): Promise<PublicMarketSnapshot | undefined> {
  for (const delay of COLD_STORE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    const stored = await brokerApi().loadStoredPublicMarketSnapshot(env)
    if (stored) return stored.snapshot
  }
  return undefined
}

/**
 * The one path that reaches the provider in a reader's request: a store with nothing in it.
 * Only the claim winner builds; everyone else waits for that write rather than falling through
 * to the provider, which would be the exact fan-out the claim prevents.
 */
async function buildFromColdStore(env: AppEnv): Promise<PublicMarketSnapshot> {
  const claimed = await brokerApi().claimMarketRefresh(env, REFRESH_LEASE_MS)
  if (claimed) return brokerApi().loadPublicMarketSnapshot(env)
  const filled = await awaitFirstRefresh(env)
  if (filled) return filled
  throw new CallerVisibleError('PublicMarketSnapshot:store-cold')
}

async function retain(
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  snapshot: PublicMarketSnapshot,
  now: number,
): Promise<Response> {
  const headers = new Headers({
    ETag: snapshotEtag(snapshot),
    [SNAPSHOT_CACHED_AT_HEADER]: new Date(now).toISOString(),
    [SNAPSHOT_GENERATED_AT_HEADER]: snapshot.syncedAt,
  })
  const response = jsonPublic(slimPublicSnapshot(snapshot), { headers })
  const stored = response.clone()
  // This header governs only the distinct Cache API copy. Visitor cache policy is restored
  // by responseForVisitor.
  stored.headers.set('Cache-Control', `public, max-age=${SNAPSHOT_RETENTION_SECONDS}`)
  try {
    await edgeCache.put(cacheKey, stored)
  } catch (error) {
    console.error('PublicMarketSnapshotCacheWriteFailed', error instanceof Error ? error.name : 'UnknownError')
  }
  return response
}

/**
 * One refresh at a time per isolate. Every reader of a stale copy schedules one, and letting
 * each run would re-read the store, and race for the provider claim, once per concurrent
 * reader for the same answer.
 */
let refreshInFlight: Promise<void> | undefined

function refreshRetainedCopy(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  now: number,
): Promise<void> | undefined {
  // The pending promise is never handed to a second request. It is a request-context I/O
  // object created in the first reader's context, and continuing it from another reader's
  // `waitUntil` is rejected by the runtime; it also pins that first caller's env, cache key
  // and instant. A reader that loses the race serves what it has and schedules nothing.
  if (refreshInFlight) return undefined
  refreshInFlight = (async () => {
    try {
      const stored = await brokerApi().loadStoredPublicMarketSnapshot(env)
      // A cold store is filled in a reader's own path, where the wait is at least visible.
      if (!stored) return
      let snapshot = quoteRefreshDue(stored, now) ? await refreshFromProvider(env) : undefined
      if (!snapshot && sessionRefreshDue(stored.snapshot, now)) {
        try {
          snapshot = await brokerApi().refreshPublicMarketSession(env, stored.snapshot)
        } catch (error) {
          console.error('PublicMarketSessionRefreshFailed', error instanceof Error ? error.name : 'UnknownError')
        }
      }
      await retain(edgeCache, cacheKey, snapshot ?? stored.snapshot, now)
    } catch (error) {
      console.error('PublicMarketSnapshotRefreshFailed', error instanceof Error ? error.name : 'UnknownError')
    } finally {
      refreshInFlight = undefined
    }
  })()
  return refreshInFlight
}

/**
 * A reader is answered from whatever is already in hand, and the refresh runs behind the
 * response. A stale price with an honest `syncedAt` is worth more to a reader than a wait
 * measured in provider round trips — and with few readers, the one who arrived after the
 * fresh window had closed was nearly every reader. Only a store with nothing in it makes a
 * reader wait for a build.
 */
export async function servePublicSnapshot(
  request: Request,
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  schedule: BackgroundScheduler,
  now = Date.now(),
): Promise<Response> {
  const cacheKey = cacheKeyFor(request)
  let retained: Response | undefined
  try {
    retained = await edgeCache.match(cacheKey)
  } catch (error) {
    console.error('PublicMarketSnapshotCacheReadFailed', error instanceof Error ? error.name : 'UnknownError')
  }
  if (retained) {
    if (copyAgeMs(retained, now) >= SNAPSHOT_FRESH_MS) {
      const task = refreshRetainedCopy(env, edgeCache, cacheKey, now)
      if (task) schedule(task)
    }
    const visitor = responseForVisitor(retained)
    return notModified(request, visitor) ?? visitor
  }

  try {
    const stored = await brokerApi().loadStoredPublicMarketSnapshot(env)
    if (stored) {
      if (refreshDue(stored, now)) {
        const task = refreshRetainedCopy(env, edgeCache, cacheKey, now)
        if (task) schedule(task)
      }
      const visitor = await retain(edgeCache, cacheKey, stored.snapshot, now)
      return notModified(request, visitor) ?? visitor
    }
    return await retain(edgeCache, cacheKey, await buildFromColdStore(env), now)
  } catch (error) {
    console.error('PublicMarketSnapshotUnavailable', error instanceof Error ? error.name : 'UnknownError')
    return jsonNoStore({ error: 'Public market sync is temporarily unavailable' }, { status: 502 })
  }
}
