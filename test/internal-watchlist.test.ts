import { readFile } from 'node:fs/promises'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureInternalWatchlistSeeded,
  ensureInternalWatchlistSymbols,
  internalWatchlistSeedFromPayloads,
  readInternalWatchlist,
  readInternalWatchlistSeedAudit,
  readInternalWatchlistSymbolDetails,
  pruneInternalWatchlistToFocus,
  removeInternalWatchlistSymbols,
  selectInternalWatchlistFocus,
} from '../src/server/internal-watchlist'
import { sqliteD1 } from './sqlite-d1'

let publicUniverseMigration: string
let internalWatchlistMigration: string
let instrumentCatalogMigration: string
let instrumentResolutionMigration: string
let store: ReturnType<typeof sqliteD1>

beforeAll(async () => {
  [publicUniverseMigration, internalWatchlistMigration, instrumentCatalogMigration, instrumentResolutionMigration] = await Promise.all([
    readFile(new URL('../migrations/0003_public_market_universe.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0006_internal_watchlist.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0008_instrument_catalog.sql', import.meta.url), 'utf8'),
    readFile(new URL('../migrations/0009_instrument_catalog_resolution.sql', import.meta.url), 'utf8'),
  ])
})

beforeEach(() => {
  store = sqliteD1([publicUniverseMigration, internalWatchlistMigration])
})

afterEach(() => store.close())

function payloads() {
  return {
    privatePayload: {
      data: { items: [{
        name: 'Long vol',
        'group-name': 'ideas',
        'order-index': 7,
        custom: { color: 'orange' },
        'watchlist-entries': [
          { symbol: 'NVDA', 'instrument-type': 'Equity', note: 'core' },
          { symbol: 'NVDA  260918C00225000', 'instrument-type': 'Equity Option', quantity: 2 },
        ],
      }] },
      pagination: { 'total-items': 1 },
    },
    publicPayload: {
      data: { items: [{
        name: 'Public movers',
        'order-index': 1,
        'watchlist-entries': [
          { symbol: 'NVDA', 'instrument-type': 'Equity', rank: 3 },
          { symbol: 'PLTR', 'instrument-type': 'Equity', rank: 8 },
        ],
      }] },
      pagination: { 'total-items': 1 },
    },
  }
}

describe('one-time tastytrade watchlist seed', () => {
  it('preserves every list and entry field while consolidating only valid equities', () => {
    const seed = internalWatchlistSeedFromPayloads(payloads())

    expect(seed.items.map((item) => item.symbol)).toEqual(['NVDA', 'PLTR'])
    expect(seed.sources).toHaveLength(2)
    expect(JSON.parse(seed.sources[0]!.metadataJson)).toMatchObject({
      name: 'Long vol', 'group-name': 'ideas', 'order-index': 7, custom: { color: 'orange' },
    })
    expect(JSON.parse(seed.sources[0]!.entries[1]!.metadataJson)).toEqual({
      symbol: 'NVDA  260918C00225000', 'instrument-type': 'Equity Option', quantity: 2,
    })
  })

  it('commits once, retains provenance, and never invokes the loader after ready', async () => {
    const loader = vi.fn(async () => payloads())
    const env = { DB: store.database }

    await ensureInternalWatchlistSeeded(env, loader, new Date('2026-08-26T10:00:00.000Z'))
    await ensureInternalWatchlistSeeded(env, loader, new Date('2026-08-26T11:00:00.000Z'))

    expect(loader).toHaveBeenCalledTimes(1)
    expect(await readInternalWatchlistSeedAudit(env)).toEqual({
      entryCount: 4,
      itemCount: 2,
      privateSourceCount: 1,
      publicSourceCount: 1,
      seededAt: '2026-08-26T10:00:00.000Z',
      status: 'ready',
    })
    expect((await readInternalWatchlist(env)).map((item) => item.symbol)).toEqual(['NVDA', 'PLTR'])
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({
      symbol: 'NVDA',
      seedMemberships: [
        { sourceKind: 'private', sourceName: 'Long vol', entryMetadata: { note: 'core' } },
        { sourceKind: 'public', sourceName: 'Public movers', entryMetadata: { rank: 3 } },
      ],
    })
  })

  it('never marks an incomplete collection ready and permits a complete retry', async () => {
    const invalid = payloads()
    invalid.privatePayload.pagination['total-items'] = 2
    const env = { DB: store.database }

    await expect(ensureInternalWatchlistSeeded(env, async () => invalid))
      .rejects.toThrow('incomplete-response')
    await expect(readInternalWatchlistSeedAudit(env)).resolves.toMatchObject({ status: 'failed', itemCount: 0 })

    await ensureInternalWatchlistSeeded(env, async () => payloads())
    await expect(readInternalWatchlistSeedAudit(env)).resolves.toMatchObject({ status: 'ready', itemCount: 2 })
  })

  it('does not let an expired importer overwrite a newer completed seed', async () => {
    const env = { DB: store.database }
    let releaseExpired: (() => void) | undefined
    const expired = ensureInternalWatchlistSeeded(env, () => new Promise((resolve) => {
      releaseExpired = () => resolve(payloads())
    }), new Date('2026-08-26T10:00:00.000Z'))
    await vi.waitFor(() => expect(releaseExpired).toBeTypeOf('function'))

    const current = payloads()
    current.privatePayload.data.items[0]!.name = 'Current private list'
    current.privatePayload.data.items[0]!['watchlist-entries'] = [
      { symbol: 'AAPL', 'instrument-type': 'Equity', note: 'current' },
    ]
    current.publicPayload.data.items[0]!.name = 'Current public list'
    current.publicPayload.data.items[0]!['watchlist-entries'] = [
      { symbol: 'MSFT', 'instrument-type': 'Equity', rank: 1 },
    ]
    await ensureInternalWatchlistSeeded(env, async () => current, new Date('2026-08-26T10:10:00.001Z'))

    const expiredFailure = expect(expired).rejects.toThrow('seed-claim-lost')
    releaseExpired?.()
    await expiredFailure
    expect((await readInternalWatchlist(env)).map((item) => item.symbol)).toEqual(['AAPL', 'MSFT'])
    await expect(readInternalWatchlistSeedAudit(env)).resolves.toMatchObject({
      itemCount: 2,
      seededAt: '2026-08-26T10:10:00.001Z',
      status: 'ready',
    })
  })

  it('selects a bounded metrics focus without returning its private priority metadata', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads(), new Date('2026-08-26T10:00:00.000Z'))
    await ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner', new Date('2026-08-26T11:00:00.000Z'))

    const focus = selectInternalWatchlistFocus(await readInternalWatchlist(env), ['PLTR'], 3)

    expect(focus).toEqual(['PLTR', 'ZZZ', 'NVDA'])
    expect(JSON.stringify(focus)).not.toContain('private')
    expect(JSON.stringify(focus)).not.toContain('tastytrade')
  })

  it('uses retained high-options-volume order only after personal symbols', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads(), new Date('2026-08-26T10:00:00.000Z'))
    const [nvda, pltr] = await readInternalWatchlist(env)
    const publicSeedItem = (symbol: string) => ({
      ...pltr!,
      metadata: { seedSourceIds: ['tastytrade-public-0'] },
      symbol,
    })
    const spiceItem = (symbol: string, origin: 'owner' | 'scheduled-research') => ({
      ...pltr!,
      origin,
      symbol,
      updatedAt: '2026-08-25T10:00:00.000Z',
    })

    const focus = selectInternalWatchlistFocus(
      [
        nvda!,
        pltr!,
        publicSeedItem('AAPL'),
        publicSeedItem('TSLA'),
        spiceItem('MSFT', 'owner'),
        spiceItem('GOOG', 'scheduled-research'),
      ],
      [],
      4,
      ['TSLA', 'AAPL', 'PLTR'],
    )

    expect(focus).toEqual(['MSFT', 'GOOG', 'NVDA', 'TSLA'])
  })

  it('prunes only the maintained list and does not repopulate an explicit deletion', async () => {
    const boundedStore = sqliteD1([
      publicUniverseMigration,
      internalWatchlistMigration,
      instrumentCatalogMigration,
      instrumentResolutionMigration,
    ])
    const symbolAt = (index: number) => {
      let value = index + 1
      let symbol = ''
      while (value > 0) {
        value--
        symbol = String.fromCharCode(65 + value % 26) + symbol
        value = Math.floor(value / 26)
      }
      return symbol
    }
    const symbols = Array.from({ length: 105 }, (_, index) => symbolAt(index))
    const env = { DB: boundedStore.database }
    await ensureInternalWatchlistSeeded(env, async () => ({
      privatePayload: [{
        name: 'Legacy private list',
        'watchlist-entries': symbols.map((symbol) => ({ symbol, 'instrument-type': 'Equity' })),
      }],
      publicPayload: [],
    }))

    await expect(pruneInternalWatchlistToFocus(env, 100)).resolves.toMatchObject({ removedCount: 5 })
    expect(await readInternalWatchlist(env)).toHaveLength(100)
    expect(boundedStore.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_seed_entries').get())
      .toEqual({ count: 105 })

    await removeInternalWatchlistSymbols(env, [symbols[0]!])
    await expect(pruneInternalWatchlistToFocus(env, 100)).resolves.toMatchObject({
      kept: expect.not.arrayContaining([symbols[0]!]),
      removedCount: 0,
    })
    expect(await readInternalWatchlist(env)).toHaveLength(99)
    boundedStore.close()
  })

  it('promotes an existing public-seed member without losing retained seed provenance', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads(), new Date('2026-08-26T10:00:00.000Z'))

    await ensureInternalWatchlistSymbols(env, ['PLTR'], 'owner', new Date('2026-08-26T11:00:00.000Z'))

    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'owner',
      seedMemberships: [{ sourceKind: 'public', sourceName: 'Public movers' }],
    })
  })
})
