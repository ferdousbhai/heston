import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readLatestDailyRecommendations,
  readDailyRecommendationsBefore,
  upsertDailyRecommendations,
} from '../src/server/daily-recommendations-store'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const dailyRecommendations = {
  id: 'daily-2026-08-28',
  recommendations: [],
  publishedAt: '2026-08-28T13:30:00.000Z',
  links: [],
  regime: 'Cautious',
  regimeDetail: 'Wait for confirmation.',
  sources: [],
  summary: 'Liquidity is thin.',
  title: 'Wait for the pitch',
}

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

describe('research dailyRecommendations store', () => {
  it('returns absence and upserts a strictly valid latest dailyRecommendations', async () => {
    await expect(readLatestDailyRecommendations(store.database)).resolves.toBeUndefined()

    await upsertDailyRecommendations(store.database, dailyRecommendations)
    await upsertDailyRecommendations(store.database, { ...dailyRecommendations, summary: 'Conditions improved.' })

    await expect(readLatestDailyRecommendations(store.database)).resolves.toMatchObject({
      id: dailyRecommendations.id,
      summary: 'Conditions improved.',
    })
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM daily_recommendations').get()).toEqual({ count: 1 })
  })

  it('fails visibly for malformed persisted JSON and domain data', async () => {
    const invalidJsonDatabase: D1Database = {
      ...unsupportedDatabase(),
      prepare: () => ({ ...unsupportedStatement(), first: async () => ({ payload_json: '{' }) }),
    }
    await expect(readLatestDailyRecommendations(invalidJsonDatabase)).rejects.toThrow()

    store.sqlite.prepare(
      'INSERT INTO daily_recommendations (id, published_at, payload_json) VALUES (?, ?, ?)',
    ).run('broken', '2026-08-29T13:30:00.000Z', '{}')
    await expect(readLatestDailyRecommendations(store.database)).rejects.toThrow()
  })

  it('reads one older dailyRecommendations at a time in publication order', async () => {
    const older = { ...dailyRecommendations, id: 'daily-2026-08-27', publishedAt: '2026-08-27T13:30:00.000Z' }
    await upsertDailyRecommendations(store.database, older)
    await upsertDailyRecommendations(store.database, dailyRecommendations)

    await expect(readDailyRecommendationsBefore(store.database, dailyRecommendations.publishedAt)).resolves.toMatchObject({
      id: older.id,
    })
    await expect(readDailyRecommendationsBefore(store.database, older.publishedAt)).resolves.toBeUndefined()
  })
})
