import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

import { favoriteSymbolsForViewer } from '../src/data/favorites'
import { mergeFavoriteSymbols, readFavoriteSymbols, removeFavoriteSymbols } from '../src/server/favorites'
import { sqliteD1 } from './sqlite-d1'

const preference = {
  id: 'primary' as const,
  pinnedSymbols: ['NVDA', 'META'],
  selectedSymbol: 'NVDA',
  selectedWatchlistId: 'public-options-watch',
}

describe('favorite display scope', () => {
  it('shows anonymous staging only until it becomes scoped to an account', () => {
    expect(favoriteSymbolsForViewer(preference, undefined)).toEqual(['NVDA', 'META'])
    expect(favoriteSymbolsForViewer(preference, 'user-a')).toEqual(['NVDA', 'META'])
    expect(favoriteSymbolsForViewer({ ...preference, favoriteUserId: 'user-a' }, 'user-a'))
      .toEqual(['NVDA', 'META'])
    expect(favoriteSymbolsForViewer({ ...preference, favoriteUserId: 'user-a' }, 'user-b'))
      .toEqual([])
    expect(favoriteSymbolsForViewer({ ...preference, favoriteUserId: 'user-a' }, undefined))
      .toEqual([])
  })
})

describe('D1 favorite synchronization', () => {
  it('converges additive device bootstraps on the per-user union and supports later removal', async () => {
    const initial = await readFile(new URL('../migrations/0001_spice.sql', import.meta.url), 'utf8')
    const favorites = await readFile(new URL('../migrations/0013_user_favorite_symbols.sql', import.meta.url), 'utf8')
    const store = sqliteD1([initial, favorites])
    store.sqlite.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run('user-a', 'Member A', 'a@example.com', 'now', 'now')
    store.sqlite.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES (?, ?, ?, 1, ?, ?)`,
    ).run('user-b', 'Member B', 'b@example.com', 'now', 'now')

    expect(await mergeFavoriteSymbols(store.database, 'user-a', ['nvda', 'META']))
      .toEqual(['META', 'NVDA'])
    expect(await mergeFavoriteSymbols(store.database, 'user-a', ['AAPL', 'NVDA']))
      .toEqual(['AAPL', 'META', 'NVDA'])
    expect(await mergeFavoriteSymbols(store.database, 'user-b', ['TSLA']))
      .toEqual(['TSLA'])
    expect(await readFavoriteSymbols(store.database, 'user-a')).toEqual(['AAPL', 'META', 'NVDA'])

    expect(await removeFavoriteSymbols(store.database, 'user-a', ['META']))
      .toEqual(['AAPL', 'NVDA'])
    expect(await readFavoriteSymbols(store.database, 'user-b')).toEqual(['TSLA'])
    store.close()
  })
})
