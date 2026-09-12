import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  readLatestDailyRecommendations,
  readDailyRecommendationsBefore,
  dailyRecommendationsUpsertStatement,
  writeRecommendationVerification,
} from '../src/server/daily-recommendations-store'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

const PUBLISHER = 'member-1'

const recommendation = {
  description: 'Demand visibility improves into the print.',
  direction: 'bullish' as const,
  headline: 'Demand visibility improves',
  recommendedOrder: { kind: 'legacy-unstructured' as const, label: 'NVDA 225c 10/16' },
  risk: 'Demand slows.',
  sources: [],
  symbol: 'NVDA',
}

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
  seedMember(store, PUBLISHER)
})

afterEach(() => store.close())

describe('research dailyRecommendations store', () => {
  it('returns absence and upserts a strictly valid latest dailyRecommendations', async () => {
    await expect(readLatestDailyRecommendations(store.database)).resolves.toBeUndefined()

    await dailyRecommendationsUpsertStatement(store.database, dailyRecommendations, PUBLISHER).run()
    await dailyRecommendationsUpsertStatement(store.database, { ...dailyRecommendations, summary: 'Conditions improved.' }, PUBLISHER).run()

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

  it('writes a verification onto one recommendation and nowhere else', async () => {
    const verified = {
      ...dailyRecommendations,
      recommendations: [
        { ...recommendation, symbol: 'NVDA' },
        { ...recommendation, symbol: 'AMD' },
      ],
    }
    await dailyRecommendationsUpsertStatement(store.database, verified, PUBLISHER).run()
    const target = {
      briefId: verified.id,
      publishedAt: verified.publishedAt,
      recommendationIndex: 1,
      symbol: 'AMD',
    }
    const verification = { checkedAt: '2026-08-28T15:00:00.000Z', reasons: [], status: 'holds' as const }

    await expect(writeRecommendationVerification(store.database, target, verification)).resolves.toBe(true)

    const stored = await readLatestDailyRecommendations(store.database)
    expect(stored?.recommendations[1]).toMatchObject({ symbol: 'AMD', verification })
    // Only that one recommendation is touched, and the publication itself is untouched: this is
    // a finding about a brief, never a republication of it.
    expect(stored?.recommendations[0]?.verification).toBeUndefined()
    expect(stored?.publishedAt).toBe(verified.publishedAt)

    // A brief republished under the same id while a check was running is a different brief, and
    // a check run against what it replaced must not be attached to it.
    await dailyRecommendationsUpsertStatement(
      store.database,
      { ...verified, publishedAt: '2026-08-28T16:00:00.000Z' },
      PUBLISHER,
    ).run()
    await expect(writeRecommendationVerification(store.database, target, verification)).resolves.toBe(false)
    // Nor may it land on a different symbol that happens to sit at the same index.
    await expect(writeRecommendationVerification(
      store.database,
      { ...target, publishedAt: '2026-08-28T16:00:00.000Z', symbol: 'NVDA' },
      verification,
    )).resolves.toBe(false)
  })

  it('reads one older dailyRecommendations at a time in publication order', async () => {
    const older = { ...dailyRecommendations, id: 'daily-2026-08-27', publishedAt: '2026-08-27T13:30:00.000Z' }
    await dailyRecommendationsUpsertStatement(store.database, older, PUBLISHER).run()
    await dailyRecommendationsUpsertStatement(store.database, dailyRecommendations, PUBLISHER).run()

    await expect(readDailyRecommendationsBefore(store.database, dailyRecommendations.publishedAt)).resolves.toMatchObject({
      id: older.id,
    })
    await expect(readDailyRecommendationsBefore(store.database, older.publishedAt)).resolves.toBeUndefined()
  })
})
