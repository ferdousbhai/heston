import { describe, expect, it } from 'vitest'

import { stagedFavoriteSymbols } from '../src/data/favorites'
import { mergeFavoriteSymbols, readFavoriteSymbols, removeFavoriteSymbols } from '../src/server/favorites'
import { migrationStore } from './sqlite-d1'

const preference = {
  id: 'primary' as const,
  pinnedSymbols: ['NVDA', 'META'],
  selectedSymbol: 'NVDA',
}

describe('anonymous favorite staging', () => {
  it('never exposes or re-stages a previous account cache while signed out', () => {
    expect(stagedFavoriteSymbols(preference)).toEqual(['NVDA', 'META'])
    expect(stagedFavoriteSymbols({ ...preference, favoriteUserId: 'user-a' })).toEqual([])
    const favoriteStageVersion = '25dc640a-2d9c-4f32-a666-a00bb1508a35'
    const versionedPreference = { ...preference, favoriteStageVersion, favoriteUserId: 'legacy-user' }
    expect(stagedFavoriteSymbols(versionedPreference)).toEqual(['NVDA', 'META'])
    expect(stagedFavoriteSymbols(versionedPreference, {
      consumedStageId: `version:${favoriteStageVersion}`,
      id: 'primary',
    })).toEqual([])
  })
})

describe('D1 favorite synchronization', () => {
  it('converges additive device bootstraps on the per-user union and supports later removal', async () => {
    const store = await migrationStore()
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
