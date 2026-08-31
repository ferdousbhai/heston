import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

describe('brokerage action migrations', () => {
  it('stores only constrained, per-user favorite symbols and cascades account deletion', async () => {
    const initial = await readFile(new URL('../migrations/0001_spice.sql', import.meta.url), 'utf8')
    const favorites = await readFile(new URL('../migrations/0013_user_favorite_symbols.sql', import.meta.url), 'utf8')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(initial)
    db.exec(favorites)
    db.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('member-1', 'Member', 'member@example.com', 1, 'now', 'now')`,
    ).run()
    db.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ('member-1', 'NVDA', 'now')`,
    ).run()

    expect(() => db.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ('member-1', 'nvda', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ('missing-user', 'META', 'now')`,
    ).run()).toThrow()
    db.prepare(`DELETE FROM "user" WHERE "id" = 'member-1'`).run()
    expect(db.prepare('SELECT count(*) AS count FROM user_favorite_symbols').get()).toEqual({ count: 0 })
    db.close()
  })

  it('rebuilds every symbol constraint onto tastytrade symbology and carries rows over', async () => {
    const read = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    for (const name of [
      '0001_spice.sql', '0003_public_market_universe.sql', '0004_catalyst_description.sql',
      '0006_internal_watchlist.sql', '0007_internal_watchlist_validation.sql',
      '0008_instrument_catalog.sql', '0009_instrument_catalog_resolution.sql',
      '0010_source_specific_market_data.sql', '0011_internal_watchlist_position_origin.sql',
      '0012_codex_catalyst_confidence.sql', '0013_user_favorite_symbols.sql',
    ]) db.exec(await read(name))

    db.exec(`
      INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
      VALUES ('BRK.B', 'Equity', 'owner', '{}', 'now', 'now'), ('NVDA', 'Equity', 'owner', '{}', 'now', 'now');
      INSERT INTO instrument_catalog
        (symbol, instrument_type, identity_refreshed_at, status_refreshed_at, created_at, updated_at)
      VALUES ('BRK.B', 'Equity', 'now', 'now', 'now', 'now');
      INSERT INTO instrument_tick_sizes (symbol, kind, tier_index, tick_value)
      VALUES ('BRK.B', 'equity', 0, 0.01);
      INSERT INTO tastytrade_market_quotes
        (symbol, price, previous_close, change_amount, change_percent, provider_updated_at, observed_at)
      VALUES ('BRK.B', 10, 9, 1, 11.1, 'now', 'now');
      INSERT INTO public_market_universe (id, payload_json, updated_at)
      VALUES ('primary', json_object('symbols', json_array('BRK.B', 'NVDA')), 'now');
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES ('member-1', 'Member', 'member@example.com', 1, 'now', 'now');
      INSERT INTO user_favorite_symbols (user_id, symbol, created_at) VALUES ('member-1', 'BRK.B', 'now');
    `)

    db.exec(await read('0014_tastytrade_equity_symbology.sql'))

    expect(db.prepare('SELECT symbol FROM internal_watchlist_items ORDER BY symbol').all())
      .toEqual([{ symbol: 'BRK/B' }, { symbol: 'NVDA' }])
    expect(db.prepare('SELECT symbol FROM instrument_catalog').all()).toEqual([{ symbol: 'BRK/B' }])
    expect(db.prepare('SELECT symbol, tick_value FROM instrument_tick_sizes').all())
      .toEqual([{ symbol: 'BRK/B', tick_value: 0.01 }])
    expect(db.prepare('SELECT symbol FROM tastytrade_market_quotes').all()).toEqual([{ symbol: 'BRK/B' }])
    expect(db.prepare('SELECT symbol FROM user_favorite_symbols').all()).toEqual([{ symbol: 'BRK/B' }])
    expect(db.prepare("SELECT payload_json FROM public_market_universe WHERE id = 'primary'").get())
      .toEqual({ payload_json: '{"symbols":["BRK/B","NVDA"]}' })
    expect(db.prepare("SELECT symbol FROM public_market_overview WHERE symbol = 'BRK/B'").get())
      .toEqual({ symbol: 'BRK/B' })

    const insertItem = db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES (?, 'Equity', 'owner', '{}', 'now', 'now')`,
    )
    expect(() => insertItem.run('V2X')).not.toThrow()
    expect(() => insertItem.run('BF/A')).not.toThrow()
    for (const rejected of ['BRK.B', 'BRK-B', '/ES', 'BRK/', 'A/B/C', 'nvda', 'ABCDEFGHIJK']) {
      expect(() => insertItem.run(rejected)).toThrow()
    }

    db.prepare(`DELETE FROM "user" WHERE "id" = 'member-1'`).run()
    expect(db.prepare('SELECT count(*) AS count FROM user_favorite_symbols').get()).toEqual({ count: 0 })
    db.close()
  })

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
    // Production had no duplicate in-flight row when 0005 was applied, so the
    // immutable migration can replace 0001's kind-scoped in-flight index.
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
    const positionOrigin = await readFile(
      new URL('../migrations/0011_internal_watchlist_position_origin.sql', import.meta.url),
      'utf8',
    )
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
    db.exec(`
      INSERT INTO internal_watchlist_seed
        (id, status, attempt_id, started_at, seeded_at)
      VALUES ('primary', 'ready', 'legacy', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z');
      INSERT INTO internal_watchlist_seed_sources
        (id, source_kind, source_index, name, metadata_json)
      VALUES ('tastytrade-private-0', 'private', 0, 'Private', '{}');
      INSERT INTO internal_watchlist_seed_entries
        (source_id, entry_index, broker_symbol, instrument_type, metadata_json)
      VALUES ('tastytrade-private-0', 0, 'NVDA', 'Equity', '{}');
    `)
    expect(() => db.exec(validation)).not.toThrow()
    expect(() => db.exec(positionOrigin)).not.toThrow()
    expect(db.prepare(
      `SELECT symbol, instrument_type FROM internal_watchlist_items WHERE symbol = 'SPY'`,
    ).get()).toEqual({ instrument_type: 'Equity', symbol: 'SPY' })
    expect(db.prepare(
      `SELECT finalized_at FROM internal_watchlist_seed WHERE id = 'primary'`,
    ).get()).toEqual({ finalized_at: '2026-08-26T10:00:00.000Z' })
    expect(db.prepare(
      `SELECT count(*) AS count FROM internal_watchlist_items WHERE symbol = 'NVDA'`,
    ).get()).toEqual({ count: 0 })
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('NVDA', 'Equity', 'position-sync', '{}', 'now', 'now')`,
    ).run()).not.toThrow()
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

  it('stores typed tastytrade Equity fields and normalized tick tiers without raw JSON', async () => {
    const migration = await readFile(new URL('../migrations/0008_instrument_catalog.sql', import.meta.url), 'utf8')
    const resolution = await readFile(new URL('../migrations/0009_instrument_catalog_resolution.sql', import.meta.url), 'utf8')
    const db = new DatabaseSync(':memory:')
    db.exec(migration)
    db.exec(resolution)

    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'instrument_%' ORDER BY name",
    ).all()).toEqual([
      { name: 'instrument_catalog' },
      { name: 'instrument_tick_sizes' },
    ])
    expect(db.prepare('PRAGMA table_info(instrument_catalog)').all().map((column) => column.name))
      .not.toContain('raw_json')
    expect(db.prepare('PRAGMA table_info(instrument_catalog)').all().map((column) => column.name))
      .toEqual(expect.arrayContaining(['resolution_status', 'identity_source']))
    db.close()
  })

  it('splits source facts into constrained tables and composes only through views', async () => {
    const initial = await readFile(new URL('../migrations/0001_spice.sql', import.meta.url), 'utf8')
    const catalystDescription = await readFile(
      new URL('../migrations/0004_catalyst_description.sql', import.meta.url),
      'utf8',
    )
    const publicUniverse = await readFile(new URL('../migrations/0003_public_market_universe.sql', import.meta.url), 'utf8')
    const instrumentCatalog = await readFile(new URL('../migrations/0008_instrument_catalog.sql', import.meta.url), 'utf8')
    const instrumentResolution = await readFile(
      new URL('../migrations/0009_instrument_catalog_resolution.sql', import.meta.url),
      'utf8',
    )
    const sourceTables = await readFile(
      new URL('../migrations/0010_source_specific_market_data.sql', import.meta.url),
      'utf8',
    )
    const codexConfidence = await readFile(
      new URL('../migrations/0012_codex_catalyst_confidence.sql', import.meta.url),
      'utf8',
    )
    const retireSocial = await readFile(
      new URL('../migrations/0019_retire_social_catalyst_tables.sql', import.meta.url),
      'utf8',
    )
    const db = new DatabaseSync(':memory:')
    db.exec(initial)
    db.exec(publicUniverse)
    db.exec(catalystDescription)
    db.exec(instrumentCatalog)
    db.exec(instrumentResolution)
    db.prepare(
      `INSERT INTO catalysts
        (id, symbol, kind, title, event_date, timing, confidence, source_name,
         source_url, updated_at, last_seen_at)
       VALUES (
        'tastytrade:NVDA:earnings', 'NVDA', 'earnings', 'NVDA earnings', '2026-11-01',
        'after-hours', 'estimated', 'tastytrade market metrics', 'https://example.com', 'now', 'now'
       )`,
    ).run()

    db.exec(sourceTables)

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalysts'").get())
      .toBeUndefined()
    expect(db.prepare('SELECT id, source_label FROM tastytrade_catalysts').get()).toEqual({
      id: 'tastytrade:NVDA:earnings',
      source_label: 'tastytrade market metrics',
    })
    expect(() => db.prepare(
      `INSERT INTO x_catalysts
        (id, symbol, kind, title, description, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'reddit:wrong-source', 'NVDA', 'conference', 'Event', 'Description', '2026-11-01',
        'unknown', 'estimated', 'Reddit · r/wallstreetbets', 'https://example.com', 'now', 'now'
       )`,
    ).run()).toThrow()
    db.prepare(
      `INSERT INTO codex_web_catalysts
        (id, symbol, kind, title, description, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'codex-web:NVDA:conference:legacy', 'NVDA', 'conference', 'Legacy event',
        'Legacy first-party research', '2026-11-02', 'unknown', 'confirmed',
        'Codex web · example.com', 'https://example.com/event', 'now', 'now'
       )`,
    ).run()

    db.exec(codexConfidence)

    expect(db.prepare(
      `SELECT confidence FROM codex_web_catalysts WHERE id = 'codex-web:NVDA:conference:legacy'`,
    ).get()).toEqual({ confidence: 'estimated' })
    expect(db.prepare(
      `SELECT confidence, source_provider FROM upcoming_catalysts
       WHERE id = 'codex-web:NVDA:conference:legacy'`,
    ).get()).toEqual({ confidence: 'estimated', source_provider: 'codex-web' })
    expect(() => db.prepare(
      `INSERT INTO codex_web_catalysts
        (id, symbol, kind, title, description, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'codex-web:NVDA:conference:invalid', 'NVDA', 'conference', 'Invalid event',
        'Description', '2026-11-03', 'unknown', 'confirmed',
        'Codex web · example.com', 'https://example.com/invalid', 'now', 'now'
       )`,
    ).run()).toThrow()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all())
      .toEqual(expect.arrayContaining([
        { name: 'public_market_overview' },
        { name: 'upcoming_catalysts' },
      ]))

    db.exec(retireSocial)

    // Storage no producer writes cannot be re-verified, so it stops being served.
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('x_catalysts', 'reddit_catalysts')",
    ).all()).toEqual([])
    // What the one remaining research producer wrote is still public, unchanged.
    expect(db.prepare(
      `SELECT source_provider FROM upcoming_catalysts WHERE id = 'codex-web:NVDA:conference:legacy'`,
    ).get()).toEqual({ source_provider: 'codex-web' })
    db.close()
  })
})
