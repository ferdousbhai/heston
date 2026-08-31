import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  PublicMarketSnapshotSchema,
  type PublicMarketSnapshot,
} from '../src/domain/market'
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
  putCalls = 0

  constructor(private response?: Response) {}

  async match(_request: Request): Promise<Response | undefined> {
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
      [SNAPSHOT_GENERATED_AT_HEADER]: new Date(NOW - age).toISOString(),
    },
  })
}

function serve(cache: PublicSnapshotCache): Promise<Response> {
  return servePublicSnapshot(new Request(SNAPSHOT_URL), {}, cache, NOW)
}

beforeEach(() => {
  vi.clearAllMocks()
  broker.loadPublicMarketSnapshot.mockResolvedValue(publicSnapshot())
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
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
    expect(cache.putCalls).toBe(0)
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
})
