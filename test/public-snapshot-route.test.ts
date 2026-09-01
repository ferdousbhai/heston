import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PublicMarketSnapshotSchema,
  type PublicMarketSnapshot,
} from '../src/domain/market'
import { SPICE_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { PUBLIC_RESPONSE_CACHE_CONTROL } from '../src/server/http'
import {
  type PublicSnapshotCache,
  servePublicSnapshot,
  SNAPSHOT_GENERATED_AT_HEADER,
} from '../src/server/public-snapshot-cache'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { marketSnapshotFixture } from './fixtures/market'

const NOW = Date.parse('2026-08-28T12:00:00.000Z')
const SNAPSHOT_URL = 'https://tryspice.xyz/api/public-snapshot'
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

function publicSnapshot(): PublicMarketSnapshot {
  const snapshot = marketSnapshotFixture()
  return PublicMarketSnapshotSchema.parse({
    ...snapshot,
    watchlists: [{ id: 'public', kind: 'public', name: 'Options Watch', symbols: [] }],
    tickers: [],
  })
}

function storedSnapshot(age: number, label: string): Response {
  return Response.json({ label }, {
    headers: {
      'Cache-Control': 'public, max-age=900',
      [SPICE_DEPLOYMENT_ID_HEADER]: 'previous-deployment',
      [SNAPSHOT_GENERATED_AT_HEADER]: new Date(NOW - age).toISOString(),
    },
  })
}

/** A snapshot as the store would return it, aged relative to the serving instant. */
function storedPublicSnapshot(ageMs: number): PublicMarketSnapshot {
  return { ...publicSnapshot(), syncedAt: new Date(NOW - ageMs).toISOString() }
}

function serve(cache: PublicSnapshotCache): Promise<Response> {
  return servePublicSnapshot(new Request(SNAPSHOT_URL), {}, cache, NOW)
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks drops recorded calls but keeps implementations, so each case restores the
  // defaults it depends on rather than inheriting whatever the previous one installed.
  broker.loadPublicMarketSnapshot.mockResolvedValue(publicSnapshot())
  broker.loadStoredPublicMarketSnapshot.mockResolvedValue(undefined)
  broker.claimMarketRefresh.mockResolvedValue(true)
  setBrokerApi(broker)
})

afterEach(() => {
  resetBrokerApi()
})

describe('public snapshot route cache', () => {
  it('serves a fresh retained copy without rebuilding it', async () => {
    const cache = new MemoryPublicSnapshotCache(storedSnapshot(30_000, 'fresh'))

    const response = await serve(cache)

    await expect(response.json()).resolves.toEqual({ label: 'fresh' })
    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_RESPONSE_CACHE_CONTROL)
    expect(response.headers.get(SPICE_DEPLOYMENT_ID_HEADER)).toBe('test')
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
    expect(cache.putCalls).toBe(0)
    expect(cache.matchedUrls).toEqual([
      'https://tryspice.xyz/api/public-snapshot?schema=4&deployment=test&copy=fresh',
    ])
  })

  it('rebuilds a copy as soon as it is stale', async () => {
    const cache = new MemoryPublicSnapshotCache(storedSnapshot(61_000, 'stale'))

    const response = await serve(cache)

    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    expect(cache.putCalls).toBe(1)
  })

  it('stores rebuilt snapshots with the same one-minute freshness bound', async () => {
    const cache = new MemoryPublicSnapshotCache(storedSnapshot(10 * 60 * 1_000 + 1, 'too-stale'))

    const response = await serve(cache)

    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_RESPONSE_CACHE_CONTROL)
    expect(response.headers.get(SNAPSHOT_GENERATED_AT_HEADER)).not.toBeNull()
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    expect(cache.putCalls).toBe(1)
    expect(cache.current()?.headers.get('Cache-Control')).toBe('public, max-age=60')
  })

  it('serves a fresh stored snapshot without claiming a refresh or calling the provider', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(30_000))
    const cache = new MemoryPublicSnapshotCache()

    const response = await serve(cache)

    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(broker.claimMarketRefresh).not.toHaveBeenCalled()
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
  })

  it('serves the stale copy to every visitor that loses the refresh claim', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000))
    broker.claimMarketRefresh.mockResolvedValue(false)
    const cache = new MemoryPublicSnapshotCache()

    const responses = await Promise.all([serve(cache), serve(cache), serve(cache)])

    for (const response of responses) {
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    }
    // The whole point: a burst of stale readers costs the provider nothing.
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
  })

  it('lets exactly the claim winner rebuild from the provider', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000))
    broker.claimMarketRefresh.mockResolvedValueOnce(true).mockResolvedValue(false)
    const cache = new MemoryPublicSnapshotCache()

    await Promise.all([serve(cache), serve(cache), serve(cache)])

    expect(broker.claimMarketRefresh).toHaveBeenCalledTimes(3)
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
  })

  it('falls back to the stored copy when the provider refresh fails', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(storedPublicSnapshot(10 * 60_000))
    broker.loadPublicMarketSnapshot.mockRejectedValue(new Error('TastytradeApi:503'))
    const cache = new MemoryPublicSnapshotCache()

    const response = await serve(cache)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
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

  it('reports unavailability only when the store is cold and the provider fails', async () => {
    broker.loadStoredPublicMarketSnapshot.mockResolvedValue(undefined)
    broker.loadPublicMarketSnapshot.mockRejectedValue(new Error('TastytradeApi:503'))

    const response = await serve(new MemoryPublicSnapshotCache())

    expect(response.status).toBe(502)
  })
})
