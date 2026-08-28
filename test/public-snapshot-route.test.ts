import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type MarketSnapshot } from '../src/domain/market'
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

function publicSnapshot(): MarketSnapshot {
  const snapshot = marketSnapshotFixture()
  snapshot.watchlists = [{ id: 'public', kind: 'public', name: 'Options Watch', symbols: [] }]
  snapshot.tickers = []
  return snapshot
}

function storedSnapshot(age: number, label: string): Response {
  return Response.json({ label }, {
    headers: {
      'Cache-Control': 'public, max-age=900',
      [SNAPSHOT_GENERATED_AT_HEADER]: new Date(NOW - age).toISOString(),
    },
  })
}

/** Holds the broker build open so a background refresh can be observed before it completes. */
function pendingSnapshotBuild(): () => void {
  let finish: ((snapshot: MarketSnapshot) => void) | undefined
  broker.loadPublicMarketSnapshot.mockReturnValue(new Promise<MarketSnapshot>((resolve) => {
    finish = resolve
  }))
  return () => finish?.(publicSnapshot())
}

function serve(cache: PublicSnapshotCache, scheduled: Promise<void>[]): Promise<Response> {
  return servePublicSnapshot(new Request(SNAPSHOT_URL), {}, cache, (task) => scheduled.push(task), NOW)
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
    const scheduled: Promise<void>[] = []

    const response = await serve(cache, scheduled)

    await expect(response.json()).resolves.toEqual({ label: 'fresh' })
    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_RESPONSE_CACHE_CONTROL)
    expect(broker.loadPublicMarketSnapshot).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(0)
    expect(cache.putCalls).toBe(0)
  })

  it('serves a stale copy before its one scheduled background refresh finishes', async () => {
    const finishBuild = pendingSnapshotBuild()
    const cache = new MemoryPublicSnapshotCache(storedSnapshot(61_000, 'stale'))
    const scheduled: Promise<void>[] = []

    const response = await serve(cache, scheduled)

    await expect(response.json()).resolves.toEqual({ label: 'stale' })
    expect(scheduled).toHaveLength(1)
    expect(cache.putCalls).toBe(0)
    finishBuild()
    await Promise.all(scheduled)
    expect(cache.putCalls).toBe(1)
  })

  it('coalesces concurrent stale requests into one background build', async () => {
    const finishBuild = pendingSnapshotBuild()
    const cache = new MemoryPublicSnapshotCache(storedSnapshot(90_000, 'stale'))
    const scheduled: Promise<void>[] = []

    const responses = await Promise.all([serve(cache, scheduled), serve(cache, scheduled)])
    const bodies = await Promise.all(responses.map((response) => response.json()))

    finishBuild()
    await Promise.all(scheduled)
    expect(bodies).toEqual([{ label: 'stale' }, { label: 'stale' }])
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(1)
    expect(cache.putCalls).toBe(1)
  })

  it('waits for a synchronous build when the retained copy exceeds the staleness cap', async () => {
    const cache = new MemoryPublicSnapshotCache(storedSnapshot(10 * 60 * 1_000 + 1, 'too-stale'))
    const scheduled: Promise<void>[] = []

    const response = await serve(cache, scheduled)

    await expect(response.json()).resolves.toMatchObject({ source: 'tastytrade' })
    expect(response.headers.get('Cache-Control')).toBe(PUBLIC_RESPONSE_CACHE_CONTROL)
    expect(response.headers.get(SNAPSHOT_GENERATED_AT_HEADER)).not.toBeNull()
    expect(broker.loadPublicMarketSnapshot).toHaveBeenCalledTimes(1)
    expect(scheduled).toHaveLength(0)
    expect(cache.putCalls).toBe(1)
    expect(cache.current()?.headers.get('Cache-Control')).toBe('public, max-age=900')
  })
})
