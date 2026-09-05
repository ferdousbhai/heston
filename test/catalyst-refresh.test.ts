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
  // Incidental attention only spends a search on a name the site tracks, so the fixture puts it
  // on the maintained list -- which is where a symbol a reader can reach has always come from.
  await store.database.prepare(
    `INSERT INTO internal_watchlist_items (symbol, instrument_type, origin, created_at, updated_at)
     VALUES ('BE', 'Equity', 'visitor-search', ?, ?)`,
  ).bind(NOW.toISOString(), NOW.toISOString()).run()
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

  it('will not let incidental attention spend a search on a name the site does not track', async () => {
    // The window bounds how often one symbol is searched; it says nothing about how many symbols
    // are reachable. Without this the reachable set was the whole instrument catalog -- thousands
    // of names, spendable with no credential, since attention has always been anonymous.
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    try {
      await store.database.prepare('DELETE FROM internal_watchlist_items WHERE symbol = ?')
        .bind('BE').run()

      await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
        .resolves.toEqual({ catalysts: [], ran: false, reason: 'untracked' })
      expect(fetchMock).not.toHaveBeenCalled()

      // The owner asking on purpose is a different signal and already costs a credential.
      await refreshCatalystsForSymbol(env(store), 'BE', NOW, true)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      store.close()
    }
  })

  it('spends a forced search the window would have refused, and resets the window', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    await refreshCatalystsForSymbol(env(store), 'BE', NOW)

    const withinWindow = new Date(NOW.getTime() + 86_400_000)
    // An owner asking on purpose is a different signal from a reader happening to look, and
    // without it a symbol searched once reads as empty for a month with no way to ask again.
    await expect(refreshCatalystsForSymbol(env(store), 'BE', withinWindow, true))
      .resolves.toMatchObject({ ran: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // The forced run writes its own receipt, so it moves the window rather than escaping it.
    await expect(refreshCatalystsForSymbol(env(store), 'BE', new Date(withinWindow.getTime() + 60_000)))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'fresh' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('will not force a search for a symbol the catalog cannot name', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()

    await expect(refreshCatalystsForSymbol(env(store), 'ZZZZ', NOW, true))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'unknown-symbol' })
    expect(fetchMock).not.toHaveBeenCalled()
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
