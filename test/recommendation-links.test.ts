import { describe, expect, it } from 'vitest'

import { DailyRecommendationsSchema, type DailyRecommendations } from '../src/domain/market'
import { dailyRecommendationsUpsertStatement } from '../src/server/daily-recommendations-store'
import {
  createRecommendationLinkHistoryTool,
  recommendationLinkUpsertStatements,
} from '../src/server/recommendation-links'
import { migrationStore } from './sqlite-d1'

function dailyRecommendations(id: string, publishedAt: string): DailyRecommendations {
  return DailyRecommendationsSchema.parse({
    id,
    links: [{
      description: 'Contains the primary announcement details.',
      previewImageUrl: 'https://images.example.com/announcement.jpg',
      title: 'Primary announcement',
      url: 'https://example.com/announcement?utm_source=feed#details',
    }],
    publishedAt,
    recommendations: [],
    regime: 'Selective',
    regimeDetail: 'Wait for evidence.',
    sources: [],
    summary: 'One useful primary source.',
    title: 'Daily recommendations',
  })
}

describe('recommendation link history', () => {
  it('canonicalizes, checks, and refuses republication on a later market date', async () => {
    const store = await migrationStore()
    const first = dailyRecommendations(
      'recommendations-2026-08-31',
      '2026-08-31T13:30:00.000Z',
    )
    const later = dailyRecommendations(
      'recommendations-2026-09-01',
      '2026-09-01T13:30:00.000Z',
    )
    try {
      await store.database.batch([
        dailyRecommendationsUpsertStatement(store.database, first),
        ...recommendationLinkUpsertStatements(store.database, first),
      ])

      expect(store.sqlite.prepare(
        `SELECT url, title, description, preview_image_url AS previewImageUrl
         FROM recommendation_links`,
      ).get()).toEqual({
        description: 'Contains the primary announcement details.',
        previewImageUrl: 'https://images.example.com/announcement.jpg',
        title: 'Primary announcement',
        url: 'https://example.com/announcement',
      })

      const checked = await createRecommendationLinkHistoryTool(
        { DB: store.database },
        later.id,
      ).execute('check-1', { urls: ['https://example.com/announcement#other'] })
      expect(checked.details).toEqual(expect.objectContaining({
        checkedUrls: ['https://example.com/announcement'],
        previouslyPublished: [expect.objectContaining({
          dailyRecommendationsId: first.id,
          url: 'https://example.com/announcement',
        })],
      }))

      await expect(store.database.batch([
        dailyRecommendationsUpsertStatement(store.database, later),
        ...recommendationLinkUpsertStatements(store.database, later),
      ])).rejects.toThrow('RecommendationLinkAlreadyPublished')
      expect(store.sqlite.prepare(
        'SELECT id FROM daily_recommendations WHERE id = ?',
      ).get(later.id)).toBeUndefined()
    } finally {
      store.close()
    }
  })
})
