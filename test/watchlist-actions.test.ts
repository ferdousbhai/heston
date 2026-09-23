import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { executeWatchlistAction } from '../src/server/watchlist-actions'
import { readInternalWatchlist } from '../src/server/internal-watchlist'
import { WatchlistActionSchema } from '../src/server/agent-contracts'
import { migrationStore, seededItems, seedFinalizedWatchlist, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
  seedFinalizedWatchlist(store, seededItems(['SPY']), [{ kind: 'private', name: 'Long vol', entries: [{ symbol: 'SPY' }] }])
})

afterEach(() => store.close())

describe('internal watchlist mutation boundary', () => {
  it('rejects punctuation-only and leading-dot values before the D1 write boundary', () => {
    expect(WatchlistActionSchema.safeParse({
      kind: 'add_watchlist_symbols', symbols: ['.SPY'],
    }).success).toBe(false)
    expect(WatchlistActionSchema.safeParse({
      kind: 'add_watchlist_symbols', symbols: ['....'],
    }).success).toBe(false)
  })

  it('adds symbols idempotently and publishes only the source-neutral universe', async () => {
    const env = { DB: store.database }
    await expect(executeWatchlistAction(env, {
      kind: 'add_watchlist_symbols', symbols: ['SPY', 'NVDA'],
    })).resolves.toEqual({
      appliedSymbols: ['SPY', 'NVDA'],
      detail: 'NVDA added to Watchlist',
      discardedSymbols: [],
    })
    await expect(executeWatchlistAction(env, {
      kind: 'add_watchlist_symbols', symbols: ['NVDA'],
    })).resolves.toEqual({
      appliedSymbols: ['NVDA'],
      detail: 'NVDA already in Watchlist; priority refreshed',
      discardedSymbols: [],
    })

    expect((await readInternalWatchlist(env)).map((item) => ({
      origin: item.origin,
      symbol: item.symbol,
    }))).toEqual([
      { origin: 'owner', symbol: 'NVDA' },
      { origin: 'owner', symbol: 'SPY' },
    ])
    const publicRow = store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()
    expect(publicRow).toBeDefined()
    const payloadJson = String(publicRow?.payload_json)
    expect(JSON.parse(payloadJson)).toEqual({ symbols: ['NVDA', 'SPY'] })
    expect(payloadJson).not.toContain('owner')
  })

  it('removes live membership without deleting immutable tastytrade seed provenance', async () => {
    const env = { DB: store.database }

    await expect(executeWatchlistAction(env, {
      kind: 'remove_watchlist_symbols', symbols: ['SPY'],
    })).resolves.toEqual({
      appliedSymbols: ['SPY'],
      detail: 'SPY removed from Watchlist',
      discardedSymbols: [],
    })
    await expect(executeWatchlistAction(env, {
      kind: 'remove_watchlist_symbols', symbols: ['SPY'],
    })).resolves.toEqual({
      appliedSymbols: [],
      detail: 'No watchlist changes were needed',
      discardedSymbols: [],
    })

    expect(await readInternalWatchlist(env)).toEqual([])
    expect(JSON.parse(String(store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()?.payload_json))).toEqual({ symbols: [] })
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_seed_entries').get())
      .toEqual({ count: 1 })
  })
})
