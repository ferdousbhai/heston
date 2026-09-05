import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  ensureInternalWatchlistSeeded,
  ensureInternalWatchlistSymbols,
  finalizeInternalWatchlist,
  internalWatchlistSeedFromPayloads,
  readInternalWatchlist,
  readInternalWatchlistCatalogCandidates,
  readInternalWatchlistSeedAudit,
  readInternalWatchlistSymbolDetails,
  pruneInternalWatchlistToFocus,
  removeInternalWatchlistSymbols,
  selectInternalWatchlistFocus,
} from '../src/server/internal-watchlist'
import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import {
  instrumentCatalogFromPayload,
  persistInstrumentCatalog,
} from '../src/server/instrument-catalog'
import { publishInternalWatchlistUniverse } from '../src/server/public-market-universe'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

function payloads() {
  return {
    privatePayload: {
      data: { items: [{
        name: 'Long vol',
        'group-name': 'recommendations',
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

function symbolAt(index: number): string {
  let value = index + 1
  let symbol = ''
  while (value > 0) {
    value--
    symbol = String.fromCharCode(65 + value % 26) + symbol
    value = Math.floor(value / 26)
  }
  return symbol
}

describe('one-time tastytrade watchlist seed', () => {
  it('preserves every list and entry field while consolidating only valid equities', () => {
    const seed = internalWatchlistSeedFromPayloads(payloads())

    expect(seed.items.map((item) => item.symbol)).toEqual(['NVDA', 'PLTR'])
    expect(seed.sources).toHaveLength(2)
    expect(JSON.parse(seed.sources[0]!.metadataJson)).toMatchObject({
      name: 'Long vol', 'group-name': 'recommendations', 'order-index': 7, custom: { color: 'orange' },
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
      finalizedAt: null,
      itemCount: 0,
      privateSourceCount: 1,
      publicSourceCount: 1,
      seededAt: '2026-08-26T10:00:00.000Z',
      status: 'ready',
    })
    await expect(readInternalWatchlist(env)).rejects.toThrow('not-finalized')
    await finalizeInternalWatchlist(env, [], new Date('2026-08-26T10:01:00.000Z'))
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
    await expect(readInternalWatchlistSeedAudit(env)).resolves.toMatchObject({ status: 'ready', itemCount: 0 })
    await finalizeInternalWatchlist(env, [])
    await expect(readInternalWatchlistSeedAudit(env)).resolves.toMatchObject({ status: 'ready', itemCount: 2 })
  })

  it('imports more than 1,000 provenance entries within one D1 invocation budget', async () => {
    const env = { DB: store.database }
    const entries = Array.from({ length: 2_000 }, (_, index) => ({
      symbol: index % 2 ? 'NVDA' : 'PLTR',
      'instrument-type': 'Equity',
      rank: index,
    }))

    await ensureInternalWatchlistSeeded(env, async () => ({
      privatePayload: [],
      publicPayload: [{ name: 'Large source', 'watchlist-entries': entries }],
    }))

    expect(store.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_seed_entries').get())
      .toEqual({ count: 2_000 })
    expect(store.queryCount()).toBeLessThan(1_000)
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
    await finalizeInternalWatchlist(env, [], new Date('2026-08-26T10:11:00.000Z'))
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
    await finalizeInternalWatchlist(env, [], new Date('2026-08-26T10:01:00.000Z'))
    await ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner', new Date('2026-08-26T11:00:00.000Z'))

    const focus = selectInternalWatchlistFocus(await readInternalWatchlist(env), ['PLTR'], 3)

    expect(focus).toEqual(['PLTR', 'ZZZ', 'NVDA'])
    expect(JSON.stringify(focus)).not.toContain('private')
    expect(JSON.stringify(focus)).not.toContain('tastytrade')
  })

  it('uses retained high-options-volume order only after personal symbols', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads(), new Date('2026-08-26T10:00:00.000Z'))
    await finalizeInternalWatchlist(env, [], new Date('2026-08-26T10:01:00.000Z'))
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
    const boundedStore = await migrationStore()
    const symbols = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 5 }, (_, index) => symbolAt(index))
    const env = { DB: boundedStore.database }
    await ensureInternalWatchlistSeeded(env, async () => ({
      privatePayload: [{
        name: 'Legacy private list',
        'watchlist-entries': symbols.map((symbol) => ({ symbol, 'instrument-type': 'Equity' })),
      }],
      publicPayload: [],
    }))

    await expect(finalizeInternalWatchlist(env, [])).resolves.toMatchObject({ finalized: true })
    expect(await readInternalWatchlist(env)).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(boundedStore.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_seed_entries').get())
      .toEqual({ count: MAX_WATCHLIST_SYMBOLS + 5 })

    await removeInternalWatchlistSymbols(env, [symbols[0]!])
    await expect(pruneInternalWatchlistToFocus(env, MAX_WATCHLIST_SYMBOLS)).resolves.toMatchObject({
      kept: expect.not.arrayContaining([symbols[0]!]),
      removedCount: 0,
    })
    expect(await readInternalWatchlist(env)).toHaveLength(MAX_WATCHLIST_SYMBOLS - 1)
    boundedStore.close()
  })

  it('retains stable catalog candidates without resurrecting an explicit deletion on rerun', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads())
    await expect(readInternalWatchlistCatalogCandidates(env)).resolves.toEqual(['NVDA', 'PLTR'])
    await finalizeInternalWatchlist(env, [], new Date('2026-08-26T12:00:00.000Z'))
    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'tastytrade-seed',
      metadata: { seedSourceIds: ['tastytrade-public-0'] },
      seedMemberships: [{ sourceKind: 'public', sourceName: 'Public movers' }],
    })
    await removeInternalWatchlistSymbols(env, ['PLTR'])
    await expect(finalizeInternalWatchlist(env, [], new Date('2026-08-26T13:00:00.000Z')))
      .resolves.toMatchObject({ finalized: false })
    expect((await readInternalWatchlist(env)).some((item) => item.symbol === 'PLTR')).toBe(false)
  })

  it('promotes an existing public-seed member without losing retained seed provenance', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads(), new Date('2026-08-26T10:00:00.000Z'))
    await finalizeInternalWatchlist(env, [], new Date('2026-08-26T10:01:00.000Z'))

    await ensureInternalWatchlistSymbols(env, ['PLTR'], 'owner', new Date('2026-08-26T11:00:00.000Z'))

    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'owner',
      seedMemberships: [{ sourceKind: 'public', sourceName: 'Public movers' }],
      updatedAt: '2026-08-26T11:00:00.000Z',
    })

    await ensureInternalWatchlistSymbols(env, ['PLTR'], 'scheduled-research', new Date('2026-08-26T12:00:00.000Z'))
    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'owner',
      updatedAt: '2026-08-26T11:00:00.000Z',
    })
  })

  it('applies the canonical origin order without allowing a downgrade', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads())
    await finalizeInternalWatchlist(env, [])
    const origins = [
      'scheduled-research',
      'agent-discussion',
      'position-sync',
      'trade-intent',
      'owner',
    ] as const

    for (const [index, origin] of origins.entries()) {
      await ensureInternalWatchlistSymbols(
        env,
        ['PLTR'],
        origin,
        new Date(`2026-08-27T10:0${index}:00.000Z`),
      )
      await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({ origin })
    }

    for (const origin of [...origins].reverse()) {
      await ensureInternalWatchlistSymbols(env, ['PLTR'], origin)
      await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({ origin: 'owner' })
    }
  })

  it('never downgrades owner provenance or publishes an addition discarded by the cap', async () => {
    const env = { DB: store.database }
    await ensureInternalWatchlistSeeded(env, async () => payloads())
    await finalizeInternalWatchlist(env, [])
    const ownerSymbols = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))
    await expect(ensureInternalWatchlistSymbols(env, [...ownerSymbols, 'ZZZ'], 'owner'))
      .rejects.toThrow('too-many-symbols')
    await expect(ensureInternalWatchlistSymbols(env, ownerSymbols, 'owner'))
      .resolves.toHaveLength(MAX_WATCHLIST_SYMBOLS)

    await expect(ensureInternalWatchlistSymbols(env, ['A'], 'scheduled-research'))
      .resolves.toEqual(['A'])
    await expect(ensureInternalWatchlistSymbols(env, ['ZZZ'], 'scheduled-research'))
      .resolves.toEqual([])
    await expect(ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner'))
      .resolves.toEqual([])

    const items = await readInternalWatchlist(env)
    expect(items).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(items.find((item) => item.symbol === 'A')?.origin).toBe('owner')
    expect(items.some((item) => item.symbol === 'ZZZ')).toBe(false)
    const publicRow = store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()
    expect(publicRow).toBeDefined()
    expect(JSON.parse(String(publicRow?.payload_json))).toEqual({ symbols: items.map((item) => item.symbol) })
  })
})

describe('delisted names', () => {
  it('keeps a name the broker no longer trades off the public universe', async () => {
    const store = await migrationStore()
    const env = { DB: store.database }
    try {
      await ensureInternalWatchlistSeeded(env, async () => ({
        privatePayload: [{
          name: 'Seed',
          'watchlist-entries': [
            { symbol: 'BE', 'instrument-type': 'Equity' },
            { symbol: 'ATVI', 'instrument-type': 'Equity' },
          ],
        }],
        publicPayload: [],
      }))
      await finalizeInternalWatchlist(env, [])
      // ATVI was acquired: the catalog still carries the row, and must, because a citation or a
      // held position may still need to resolve it. It just may not be offered to a reader.
      await persistInstrumentCatalog(env, [
        ...instrumentCatalogFromPayload([
          { active: false, description: 'Activision Blizzard', 'instrument-type': 'Equity', symbol: 'ATVI' },
          { active: true, description: 'Bloom Energy', 'instrument-type': 'Equity', symbol: 'BE' },
        ], ['ATVI', 'BE']),
      ])

      await publishInternalWatchlistUniverse(env)
      const stored = store.sqlite
        .prepare("SELECT payload_json FROM public_market_universe WHERE id='primary'").get()
      const published = z.object({ symbols: z.array(z.string()) })
        .parse(JSON.parse(z.object({ payload_json: z.string() }).parse(stored).payload_json))
        .symbols
      expect(published).toContain('BE')
      expect(published).not.toContain('ATVI')
      // Still on the maintained list -- excluded from readers, not deleted from the record.
      expect((await readInternalWatchlist(env)).map((item) => item.symbol)).toContain('ATVI')
    } finally {
      store.close()
    }
  })
})
