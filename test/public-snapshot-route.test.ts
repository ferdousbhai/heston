import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PublicMarketSnapshotSchema,
  type PublicMarketSnapshot,
} from '../src/domain/market'
import { HESTON_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { PUBLIC_RESPONSE_CACHE_CONTROL } from '../src/server/http'
import {
  type PublicSnapshotCache,
  PRE_SESSION_REFRESH_MS,
  providerRefreshDue,
  publicSessionStatus,
  quoteCatchUpDue,
  servePublicSnapshot,
  sessionRefreshDue,
  SNAPSHOT_CACHED_AT_HEADER,
  SNAPSHOT_GENERATED_AT_HEADER,
  SNAPSHOT_MARKET_CLOSES_AT_HEADER,
  SNAPSHOT_MARKET_OPENS_AT_HEADER,
  SNAPSHOT_MARKET_STATE_HEADER,
  snapshotEtag,
} from '../src/server/public-snapshot-cache'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { marketSnapshotFixture } from './fixtures/market'

const NOW = Date.parse('2026-08-28T12:00:00.000Z')
const SNAPSHOT_URL = 'https://heston.io/api/public-snapshot'
const broker = stubBroker()

class MemoryPublicSnapshotCache implements PublicSnapshotCache {
  matchedUrls: string[] = []
  putCalls = 0

  constructor(private response?: Response) {}

  async match(request: Request): Promise<Response | undefined> {
    this.matchedUrls.push(request.url)
    return this.response?.clone()
  }

  async put(_request: Request, response: Response): Promise<void> {
    this.putCalls += 1
    this.response = response.clone()
  }

  current(): Response | undefined {
    return this.response?.clone()
  }
}

/** Collects what the route scheduled past the response, so a test can wait for it. */
class Background {
  tasks: Promise<unknown>[] = []
  schedule = (task: Promise<unknown>): void => { this.tasks.push(task) }
  async settle(): Promise<void> { await Promise.all(this.tasks) }
}

function publicSnapshot(overrides: Partial<PublicMarketSnapshot> = {}): PublicMarketSnapshot {
  const snapshot = marketSnapshotFixture()
  return PublicMarketSnapshotSchema.parse({
    ...snapshot,
    watchlists: [{ id: 'public', kind: 'public', name: 'Options Watch', symbols: [] }],
    tickers: [],
    ...overrides,
  })
}

function retainedCopy(age: number, label: string): Response {
  return Response.json({ label }, {
    headers: {
      'Cache-Control': 'public, max-age=900',
      [HESTON_DEPLOYMENT_ID_HEADER]: 'previous-deployment',
      [SNAPSHOT_CACHED_AT_HEADER]: new Date(NOW - age).toISOString(),
      [SNAPSHOT_GENERATED_AT_HEADER]: new Date(NOW - age).toISOString(),
    },
  })
}

/** A snapshot as the store would return it, observed by the provider this long ago. */
function storedPublicSnapshot(ageMs: number, overrides: Partial<PublicMarketSnapshot> = {}): PublicMarketSnapshot {
  return { ...publicSnapshot(overrides), syncedAt: new Date(NOW - ageMs).toISOString() }
}

function serve(cache: PublicSnapshotCache, background = new Background()): Promise<Response> {
  return servePublicSnapshot(new Request(SNAPSHOT_URL), {}, cache, background.schedule, NOW)
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks drops recorded calls but keeps implementations, so each case restores the
  // defaults it depends on rather than inheriting whatever the previous one installed.
  broker.loadPublicMarketSnapshot.mockResolvedValue(publicSnapshot({ marketState: 'open' }))
  broker.loadStoredPublicMarketSnapshot.mockResolvedValue(undefined)
  broker.claimMarketRefresh.mockResolvedValue(true)
  setBrokerApi(broker)
})

afterEach(() => {
  resetBrokerApi()
})

describe('public snapshot route cache', () => {
  it('serves a fresh retained copy without rebuilding it', async () => {
    const cache = new MemoryPublicSnapshotCache(retainedCopy(30_000, 'fresh'))
    const background = new Background()

    const response = await serve(cache, background)

    await expect(response.json()).resolves.toEqual({ label: 'fresh' })
    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_RESPONSE_CACHE_CONTROL)
    expect(response.headers.get(HESTON_DEPLOYMENT_ID_HEADER)).toBe('test')
    expect(background.tasks).toHaveLength(0)
    expect(broker.loadStoredPublicMarketSnapshot).not.toHaveBeenCalled()
    expect(cache.putCalls).toBe(0)
    expect(cache.matchedUrls).toEqual([
      'https://heston.io/api/public-snapshot?schema=6&deployment=test&copy=fresh',
    ])
  })

  it('validates the session projection when an older cache copy has no session headers', async () => {
    const snapshot = storedPublicSnapshot(30_000, { marketState: 'pre', marketOpensAt: '2026-08-28T13:30:00.000Z' })
    const headers = retainedCopy(30_000, 'legacy').headers
    const cache = new MemoryPublicSnapshotCache(Response.json(snapshot, { headers }))
    const response = await servePublicSnapshot(new Request(`${SNAPSHOT_URL}?fields=session`), {}, cache, () => undefined, NOW)
    await expect(response.json()).resolves.toEqual(publicSessionStatus(snapshot))

    const invalidCache = new MemoryPublicSnapshotCache(Response.json({ ...snapshot, marketState: 'invalid' }, { headers }))
    await expect(servePublicSnapshot(new Request(`${SNAPSHOT_URL}?fields=session`), {}, invalidCache, () => undefined, NOW)).rejects.toThrow()
  })

  it('answers fields=session from retained headers without reading the body', async () => {
    const snapshot = storedPublicSnapshot(30_000, {
      marketOpensAt: '2026-08-28T13:30:00.000Z',
      marketState: 'open',
    })
    const cache = new MemoryPublicSnapshotCache(new Response('not-json', {
      headers: {
        'Cache-Control': 'public, max-age=900',
        [SNAPSHOT_CACHED_AT_HEADER]: new Date(NOW).toISOString(),
        [SNAPSHOT_GENERATED_AT_HEADER]: snapshot.syncedAt,
        [SNAPSHOT_MARKET_STATE_HEADER]: 'open',
        [SNAPSHOT_MARKET_OPENS_AT_HEADER]: '2026-08-28T13:30:00.000Z',
      },
    }))
    const response = await servePublicSnapshot(
      new Request(`${SNAPSHOT_URL}?fields=session`),
      {},
      cache,
      new Background().schedule,
      NOW,
    )
    await expect(response.json()).resolves.toEqual(publicSessionStatus(snapshot))
    expect(cache.putCalls).toBe(0)
  })

  it('answers 304 when the observation has not changed', async () => {
    const snapshot = storedPublicSnapshot(30_000, {
      marketClosesAt: '2026-08-28T20:00:00.000Z',
      marketOpensAt: '2026-08-28T13:30:00.000Z',
      marketState: 'open',
    })
    const etag = snapshotEtag(snapshot)
    const cache = new MemoryPublicSnapshotCache(Response.json(snapshot, {
      headers: {
        ETag: etag,
        'Cache-Control': 'public, max-age=900',
        [SNAPSHOT_CACHED_AT_HEADER]: new Date(NOW).toISOString(),
        [SNAPSHOT_GENERATED_AT_HEADER]: snapshot.syncedAt,
        [SNAPSHOT_MARKET_STATE_HEADER]: 'open',
        [SNAPSHOT_MARKET_OPENS_AT_HEADER]: '2026-08-28T13:30:00.000Z',
        [SNAPSHOT_MARKET_CLOSES_AT_HEADER]: '2026-08-28T20:00:00.000Z',
      },
    }))
    const response = await servePublicSnapshot(
      new Request(SNAPSHOT_URL, { headers: { 'If-None-Match': etag } }),
      {},
      cache,
      new Background().schedule,
      NOW,
    )
    expect(response.status).toBe(304)
    expect(await response.text()).toBe('')
    expect(response.headers.get(SNAPSHOT_MARKET_OPENS_AT_HEADER)).toBe('2026-08-28T13:30:00.000Z')
    expect(response.headers.get(SNAPSHOT_MARKET_CLOSES_AT_HEADER)).toBe('2026-08-28T20:00:00.000Z')
    expect(cache.putCalls).toBe(0)
  })

  it('does not 304 when the brief changed on the same market observation', async () => {
    const snapshot = storedPublicSnapshot(30_000, {
      marketState: 'closed',
      recommendations: {
        id: 'recommendations-2026-09-18',
        links: [],
        model: 'muse',
        publishedAt: '2026-09-18T15:49:52.243Z',
        recommendations: [],
        regime: 'post-hike',
        regimeDetail: 'tech leads',
        summary: 'Nvidia and Applied Digital',
        title: 'Post-hike tech chase',
      },
    })
    const previous = snapshotEtag({ syncedAt: snapshot.syncedAt, marketState: snapshot.marketState })
    const current = snapshotEtag(snapshot)
    expect(current).not.toBe(previous)
    const cache = new MemoryPublicSnapshotCache(Response.json(snapshot, {
      headers: {
        ETag: current,
        'Cache-Control': 'public, max-age=900',
        [SNAPSHOT_CACHED_AT_HEADER]: new Date(NOW).toISOString(),
        [SNAPSHOT_GENERATED_AT_HEADER]: snapshot.syncedAt,
        [SNAPSHOT_MARKET_STATE_HEADER]: 'closed',
      },
    }))
    const response = await servePublicSnapshot(
      new Request(SNAPSHOT_URL, { headers: { 'If-None-Match': previous } }),
      {},
      cache,
      new Background().schedule,
      NOW,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      recommendations: { id: 'recommendations-2026-09-18' },
    })
  })

  it('serves a stale retained copy at once and rebuilds it behind the response', async () => {
    // The store answers only once released, which is what proves the reader never waited on it.
    let release!: (snapshot: PublicMarketSnapshot) => void
    broker.loadStoredPublicMarketSnapshot.mockReturnValue(new Promise<PublicMarketSnapshot>((resolve) => { release = resolve }))
    const cache = new MemoryPublicSnapshotCache(retainedCopy(61_000, 'stale'))
    const background = new Background()

    const response = await serve(cache, background)

    await expect(response.json()).resolves.toEqual({ label: 'stale' })
    expect(cache.putCalls).toBe(0)
    expect(background.tasks).toHaveLength(1)

    release(storedPublicSnapshot(30_000, { marketState: 'open' }))
    await background.settle()

    expect(cache.putCalls).toBe(1)
    await expect(cache.current()?.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(cache.current()?.headers.get(SNAPSHOT_CACHED_AT_HEADER)).toBe(new Date(NOW).toISOString())
    // A provider reading inside its own bound is reused; only the store was re-read.
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
  })

  it('retains rebuilt copies long enough to serve them while the next refresh runs', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(30_000))
    const cache = new MemoryPublicSnapshotCache()

    const response = await serve(cache)

    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_RESPONSE_CACHE_CONTROL)
    expect(response.headers.get(SNAPSHOT_GENERATED_AT_HEADER)).toBe(new Date(NOW - 30_000).toISOString())
    expect(cache.current()?.headers.get('Cache-Control')).toBe('public, max-age=90')
  })

  it('serves a fresh stored snapshot without claiming a refresh or calling the provider', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(30_000, { marketState: 'open' }))
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const response = await serve(cache, background)

    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(background.tasks).toHaveLength(0)
    expect(broker.claimMarketRefresh).not.toHaveBeenCalled()
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
  })

  it('serves the stale stored snapshot and refreshes the provider behind the response', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000, { marketState: 'open' }))
    // The provider answers only once released, which is what proves the reader never waited on it.
    let release!: (snapshot: PublicMarketSnapshot) => void
    broker.loadPublicMarketSnapshot.mockReturnValue(new Promise<PublicMarketSnapshot>((resolve) => { release = resolve }))
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const response = await serve(cache, background)

    await expect(response.json()).resolves.toMatchObject({
      source: 'tastytrade',
      syncedAt: new Date(NOW - 10 * 60_000).toISOString(),
    })
    expect(cache.putCalls).toBe(1)

    release(publicSnapshot({ marketState: 'open' }))
    await background.settle()

    expect(broker.claimMarketRefresh).toHaveBeenCalledTimes(1)
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    // The retained copy now carries the provider's fresh reading.
    await expect(cache.current()?.json()).resolves.toMatchObject({ marketState: 'open', syncedAt: publicSnapshot().syncedAt })
  })

  it('runs one refresh for a burst of stale readers', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000, { marketState: 'open' }))
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const responses = await Promise.all([serve(cache, background), serve(cache, background), serve(cache, background)])
    await background.settle()

    for (const response of responses) expect(response.status).toBe(200)
    // The whole point: a burst of stale readers costs the provider one call, not one each.
    expect(broker.claimMarketRefresh).toHaveBeenCalledTimes(1)
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    // And the readers that lost the race schedule nothing at all. The winner's pending promise
    // is a request-context I/O object; continuing it from another request's waitUntil is
    // rejected by the runtime, which no test that runs every request in one context can show.
    expect(background.tasks).toHaveLength(1)
  })

  it('keeps the stored copy when the refresh claim is lost', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000, { marketState: 'open' }))
    broker.claimMarketRefresh.mockResolvedValue(false)
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    await serve(cache, background)
    await background.settle()

    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
    await expect(cache.current()?.json()).resolves.toMatchObject({ syncedAt: new Date(NOW - 10 * 60_000).toISOString() })
  })

  it('keeps the stored copy when the provider refresh fails', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000, { marketState: 'open' }))
    broker.loadPublicMarketSnapshot.mockRejectedValue(new Error('TastytradeApi:503'))
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const response = await serve(cache, background)
    await background.settle()

    expect(response.status).toBe(200)
    expect(cache.putCalls).toBe(2)
    await expect(cache.current()?.json()).resolves.toMatchObject({ source: 'tastytrade' })
  })

  it('lets a closed market age until the bell the provider named', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60 * 60_000, {
      marketOpensAt: new Date(NOW + 60 * 60_000).toISOString(),
      marketState: 'closed',
    }))
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const response = await serve(cache, background)

    await expect(response.json()).resolves.toMatchObject({ marketState: 'closed' })
    expect(background.tasks).toHaveLength(0)
    expect(broker.claimMarketRefresh).not.toHaveBeenCalled()
  })

  it('waits for the claim winner rather than piling onto a cold store', async () => {
    broker.claimMarketRefresh.mockResolvedValue(false)
    broker.loadStoredPublicMarketSnapshot
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue(storedPublicSnapshot(1_000))

    const response = await serve(new MemoryPublicSnapshotCache())

    expect(response.status).toBe(200)
    // The whole point of the wait: a cold store must not become N concurrent provider calls.
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
  })

  it('builds from the provider in the reader path only when the store is cold', async () => {
    const response = await serve(new MemoryPublicSnapshotCache())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
  })

  it('reports unavailability only when the store is cold and the provider fails', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(undefined)
    broker.loadPublicMarketSnapshot.mockRejectedValue(new Error('TastytradeApi:503'))

    const response = await serve(new MemoryPublicSnapshotCache())

    expect(response.status).toBe(502)
  })
})

describe('provider refresh policy', () => {
  const minute = 60_000
  const hour = 60 * minute

  it('refreshes an open market once its reading is a minute old', () => {
    expect(providerRefreshDue(storedPublicSnapshot(minute - 1, { marketState: 'open' }), NOW)).toBe(false)
    expect(providerRefreshDue(storedPublicSnapshot(minute, { marketState: 'open' }), NOW)).toBe(true)
  })

  it('lets a closed market stand until the next open, then refreshes', () => {
    const closed = { marketOpensAt: new Date(NOW + hour).toISOString(), marketState: 'closed' as const }
    expect(providerRefreshDue(storedPublicSnapshot(12 * hour, closed), NOW)).toBe(false)
    expect(providerRefreshDue(storedPublicSnapshot(12 * hour, closed), NOW + hour)).toBe(false)
    expect(sessionRefreshDue(storedPublicSnapshot(12 * hour, closed), NOW + hour)).toBe(true)
    expect(providerRefreshDue(storedPublicSnapshot(12 * hour, { ...closed, marketState: 'after' }), NOW)).toBe(false)
    expect(providerRefreshDue(storedPublicSnapshot(12 * hour, { ...closed, marketState: 'pre' }), NOW)).toBe(false)
  })

  it('errs toward refreshing when the session is unlabelled or names no open', () => {
    expect(providerRefreshDue(storedPublicSnapshot(minute, { marketState: 'unknown' }), NOW)).toBe(true)
    expect(providerRefreshDue(storedPublicSnapshot(minute, { marketOpensAt: undefined, marketState: 'closed' }), NOW)).toBe(true)
  })

  it('catches up closed quotes that missed a cash session', () => {
    expect(quoteCatchUpDue(storedPublicSnapshot(6 * hour, { marketState: 'closed' }), NOW)).toBe(true)
    expect(quoteCatchUpDue(storedPublicSnapshot(hour, { marketState: 'closed' }), NOW)).toBe(false)
    expect(quoteCatchUpDue(storedPublicSnapshot(12 * hour, { marketState: 'open' }), NOW)).toBe(false)
  })
})

describe('pre-market session refresh', () => {
  const minute = 60_000
  const hour = 60 * minute

  it('asks for session state overnight-after, inside six hours of the bell, without a quote rebuild', () => {
    const after = {
      marketOpensAt: new Date(NOW + hour).toISOString(),
      marketState: 'after' as const,
    }
    expect(sessionRefreshDue(storedPublicSnapshot(12 * hour, after), NOW)).toBe(true)
    expect(sessionRefreshDue(storedPublicSnapshot(minute - 1, after), NOW)).toBe(true)
    expect(sessionRefreshDue(storedPublicSnapshot(12 * hour, {
      ...after,
      marketOpensAt: new Date(NOW + PRE_SESSION_REFRESH_MS + minute).toISOString(),
    }), NOW)).toBe(false)
    expect(sessionRefreshDue(storedPublicSnapshot(12 * hour, { ...after, marketState: 'closed' }), NOW)).toBe(false)
    expect(sessionRefreshDue(storedPublicSnapshot(12 * hour, { ...after, marketState: 'pre' }), NOW)).toBe(false)
  })

  it('retags a named open that already rang without rebuilding quotes', async () => {
    const stored = storedPublicSnapshot(18 * hour, {
      marketOpensAt: new Date(NOW - hour).toISOString(),
      marketState: 'closed',
    })
    expect(providerRefreshDue(stored, NOW)).toBe(false)
    expect(sessionRefreshDue(stored, NOW)).toBe(true)
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(stored)
    broker.loadPublicMarketSnapshot.mockRejectedValue(new Error('TastytradeApi:503'))
    broker.refreshPublicMarketSession.mockResolvedValue({
      ...stored,
      marketOpensAt: new Date(NOW + 48 * hour).toISOString(),
      marketState: 'closed',
    })
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const response = await serve(cache, background)
    await expect(response.json()).resolves.toMatchObject({ marketState: 'closed' })
    await background.settle()

    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    expect(broker.refreshPublicMarketSession).toHaveBeenCalledTimes(1)
    await expect(cache.current()?.json()).resolves.toMatchObject({
      marketOpensAt: new Date(NOW + 48 * hour).toISOString(),
    })
  })

  it('schedules a session-only refresh rather than a full provider rebuild', async () => {
    const stored = storedPublicSnapshot(12 * hour, {
      marketOpensAt: new Date(NOW + hour).toISOString(),
      marketState: 'after',
    })
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(stored)
    broker.refreshPublicMarketSession.mockResolvedValue({ ...stored, marketState: 'pre' })
    const cache = new MemoryPublicSnapshotCache()
    const background = new Background()

    const response = await serve(cache, background)
    await expect(response.json()).resolves.toMatchObject({ marketState: 'after' })
    await background.settle()

    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
    expect(broker.refreshPublicMarketSession).toHaveBeenCalledTimes(1)
    await expect(cache.current()?.json()).resolves.toMatchObject({ marketState: 'pre' })
  })
})
