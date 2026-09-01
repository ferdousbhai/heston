import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  instrumentCatalogFromPayload,
  persistInstrumentCatalog,
  unresolvedInstrumentCatalogItem,
} from '../src/server/instrument-catalog'
import {
  CATALYST_REFRESH_INTERVAL_DAYS,
  refreshCatalystsForSymbol,
} from '../src/server/catalyst-refresh'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const NOW = new Date('2026-09-01T13:00:00.000Z')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function storeWithCatalog(): Promise<SqliteD1Store> {
  const store = await migrationStore()
  await persistInstrumentCatalog({ DB: store.database }, [
    ...instrumentCatalogFromPayload([{
      active: true,
      description: 'Bloom Energy Corporation',
      'instrument-type': 'Equity',
      symbol: 'BE',
    }], ['BE']),
    unresolvedInstrumentCatalogItem('HUH'),
  ])
  return store
}

function stubExa(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => Response.json({
    output: {
      content: {
        events: [{
          date: '2026-10-14',
          kind: 'investor-event',
          sourceUrl: 'https://ir.bloomenergy.com/events',
          title: 'Bloom Energy investor day',
        }],
      },
      grounding: [{
        citations: [{ url: 'https://ir.bloomenergy.com/events' }],
        confidence: 'high',
        field: 'events[0].date',
      }],
    },
    results: [{
      text: 'The investor day is scheduled for Oct. 14.',
      url: 'https://ir.bloomenergy.com/events',
    }],
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const exaKey: SecretsStoreSecret = { get: async () => 'exa-key' }

function env(store: SqliteD1Store) {
  return { DB: store.database, EXA_API_KEY: exaKey }
}

function catalystRows(store: SqliteD1Store): unknown[] {
  return store.sqlite.prepare("SELECT id, symbol FROM catalysts WHERE source_provider = 'exa'").all()
}

describe('catalyst coverage seeded by favorites', () => {
  it('searches a favorited symbol once and stores what the search bound', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()

    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
      .resolves.toMatchObject({ ran: true, catalysts: [{ id: 'exa:BE:investor-event:2026-10-14' }] })

    expect(catalystRows(store)).toEqual([{ id: 'exa:BE:investor-event:2026-10-14', symbol: 'BE' }])
    expect(store.sqlite.prepare('SELECT symbol, status, catalyst_count FROM catalyst_runs').all())
      .toEqual([{ symbol: 'BE', status: 'complete', catalyst_count: 1 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('buys no second search inside the refresh window, and one again after it', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    await refreshCatalystsForSymbol(env(store), 'BE', NOW)

    const withinWindow = new Date(NOW.getTime() + (CATALYST_REFRESH_INTERVAL_DAYS - 1) * 86_400_000)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', withinWindow))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'fresh' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const afterWindow = new Date(NOW.getTime() + (CATALYST_REFRESH_INTERVAL_DAYS + 1) * 86_400_000)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', afterWindow))
      .resolves.toMatchObject({ ran: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('spends nothing on a symbol the catalog cannot name', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()

    await expect(refreshCatalystsForSymbol(env(store), 'HUH', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'unknown-symbol' })
    await expect(refreshCatalystsForSymbol(env(store), 'ZZZZ', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'unknown-symbol' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM catalyst_runs').get()).toEqual({ count: 0 })
    store.close()
  })

  it('records a failed search so the next favorite does not repeat it immediately', async () => {
    const store = await storeWithCatalog()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
      .resolves.toEqual({ catalysts: [], ran: true })

    expect(store.sqlite.prepare('SELECT status, detail FROM catalyst_runs').get())
      .toEqual({ status: 'failed', detail: 'ExaSearchFailed:500' })
    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'fresh' })
    store.close()
  })
})
