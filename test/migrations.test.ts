import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

describe('brokerage action migrations', () => {
  it('serializes every order kind after the exact production-applied 0005 migration', async () => {
    const initial = await readFile(new URL('../migrations/0001_spice.sql', import.meta.url), 'utf8')
    const migration = await readFile(new URL('../migrations/0005_brokerage_action_state.sql', import.meta.url), 'utf8')
    const db = new DatabaseSync(':memory:')
    db.exec(initial)
    const insert = db.prepare(
      `INSERT INTO brokerage_actions
        (id, status, payload_json, token_digest, created_at, expires_at)
       VALUES (?, ?, ?, 'digest', '2026-08-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    )
    // This kind was outside the original allowlist. Production had no duplicate
    // in-flight row when 0005 was applied, so the immutable migration can replace it.
    insert.run('legacy-vertical', 'pending', JSON.stringify({ kind: 'place_vertical_spread_order' }))

    expect(() => db.exec(migration)).not.toThrow()
    expect(() => insert.run('blocked', 'pending', JSON.stringify({ kind: 'future_order_kind' })))
      .toThrow(/UNIQUE constraint/)

    db.prepare("UPDATE brokerage_actions SET status = 'expired' WHERE id = 'legacy-vertical'").run()
    expect(() => insert.run('accepted', 'pending', JSON.stringify({ kind: 'future_order_kind' })))
      .not.toThrow()
    db.close()
  })

  it('adds the internal watchlist seed, normalized live items, and immutable provenance tables', async () => {
    const publicUniverse = await readFile(new URL('../migrations/0003_public_market_universe.sql', import.meta.url), 'utf8')
    const migration = await readFile(new URL('../migrations/0006_internal_watchlist.sql', import.meta.url), 'utf8')
    const validation = await readFile(new URL('../migrations/0007_internal_watchlist_validation.sql', import.meta.url), 'utf8')
    const db = new DatabaseSync(':memory:')
    db.exec(publicUniverse)
    db.exec(migration)

    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'internal_watchlist_%' ORDER BY name`,
    ).all()).toEqual([
      { name: 'internal_watchlist_items' },
      { name: 'internal_watchlist_seed' },
      { name: 'internal_watchlist_seed_entries' },
      { name: 'internal_watchlist_seed_sources' },
    ])
    db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('SPY', 'Equity', 'owner', '{}', 'now', 'now')`,
    ).run()
    expect(() => db.exec(validation)).not.toThrow()
    expect(db.prepare(
      `SELECT symbol, instrument_type FROM internal_watchlist_items WHERE symbol = 'SPY'`,
    ).get()).toEqual({ instrument_type: 'Equity', symbol: 'SPY' })
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('nvda', 'Equity', 'owner', '{}', 'now', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('NVDA!', 'Equity', 'owner', '{}', 'now', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('NVDA', 'Equity Option', 'owner', '{}', 'now', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `UPDATE internal_watchlist_items SET symbol = 'SPY!' WHERE symbol = 'SPY'`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `UPDATE internal_watchlist_items SET instrument_type = 'Equity Option' WHERE symbol = 'SPY'`,
    ).run()).toThrow()
    db.close()
  })
})
