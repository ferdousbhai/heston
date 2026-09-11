import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type PublicSymbolLookup } from '../src/domain/market'
import { type PublicSnapshotCache } from '../src/server/public-snapshot-cache'
import { servePublicSymbolSearch } from '../src/server/public-symbol-search'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { marketSnapshotFixture } from './fixtures/market'

const SEARCH_URL = 'https://tryspice.xyz/api/public-symbol-search'
const broker = stubBroker()

class MemoryCache implements PublicSnapshotCache {
  private readonly responses = new Map<string, Response>()

  putCalls = 0

  async match(request: Request): Promise<Response | undefined> {
    return this.responses.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    this.putCalls += 1
    this.responses.set(request.url, response.clone())
  }
}

function lookup(): PublicSymbolLookup {
  return { catalysts: [], ticker: marketSnapshotFixture().tickers[0]!, watchlisted: true }
}

function serve(query: string, cache: PublicSnapshotCache): Promise<Response> {
  return servePublicSymbolSearch(
    new Request(`${SEARCH_URL}?q=${encodeURIComponent(query)}`),
    {},
    cache,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setBrokerApi(broker)
})

afterEach(() => {
  resetBrokerApi()
})

describe('public symbol search route', () => {
  it('answers one lookup and replays it for the same search', async () => {
    broker.lookupPublicMarketSymbol.mockResolvedValue(lookup())
    const cache = new MemoryCache()

    const first = await serve('tqqq', cache)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({ watchlisted: true })
    expect(cache.putCalls).toBe(1)

    // The same search in any letter case is the same question, so it costs no second
    // broker read and no second maintained-list write.
    const replay = await serve(' TQQQ ', cache)
    expect(replay.status).toBe(200)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(1)
    expect(cache.putCalls).toBe(1)
  })

  it('keeps a search that matched nothing, and never asks the broker for an empty one', async () => {
    broker.lookupPublicMarketSymbol.mockResolvedValue(undefined)
    const cache = new MemoryCache()

    const missing = await serve('zzzz', cache)
    expect(missing.status).toBe(404)
    expect(cache.putCalls).toBe(1)

    const blank = await serve('   ', cache)
    expect(blank.status).toBe(400)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable search without storing the failure', async () => {
    broker.lookupPublicMarketSymbol.mockRejectedValue(new Error('TastytradeUnavailable'))
    const cache = new MemoryCache()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const failed = await serve('tqqq', cache)

    expect(failed.status).toBe(503)
    expect(failed.headers.get('Cache-Control')).toContain('no-store')
    expect(cache.putCalls).toBe(0)
  })
})
