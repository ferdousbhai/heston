import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'
import { z } from 'zod'

import { type DailyRecommendations } from '../domain/market'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import { MAX_RESEARCH_PAGE_READS } from './research-contracts'
import { recommendationLinkKey } from './research-url'

const RecommendationLinkCheckParameters = Type.Object({
  urls: Type.Array(Type.String({ maxLength: 2_000 }), {
    description: 'Candidate reader-link URLs to check against publication history.',
    maxItems: MAX_RESEARCH_PAGE_READS,
    minItems: 1,
  }),
}, { additionalProperties: false })

const RecommendationLinkHistoryRowSchema = z.object({
  dailyRecommendationsId: z.string(),
  firstPublishedAt: z.string(),
  url: z.string().url(),
})

export type RecommendationLinkHistoryCheck = {
  checkedUrls: string[]
  previouslyPublished: z.infer<typeof RecommendationLinkHistoryRowSchema>[]
}

export function createRecommendationLinkHistoryTool(
  env: AppEnv,
  currentDailyRecommendationsId: string,
): AgentTool<typeof RecommendationLinkCheckParameters, RecommendationLinkHistoryCheck | { error: string }> {
  return {
    description: 'Check candidate reader links against all previously published daily recommendations.',
    execute: async (_toolCallId, params) => {
      if (!env.DB) throw new Error('RecommendationLinkHistoryUnavailable')
      const normalized = params.urls.map(recommendationLinkKey)
      const invalid = params.urls.find((_url, index) => normalized[index] === undefined)
      if (invalid !== undefined) return textResult({ error: `not a public HTTPS page: ${invalid.slice(0, 80)}` })
      const checkedUrls = [...new Set(normalized.filter((url) => url !== undefined))]
      const result = await env.DB.prepare(
        `SELECT
           url,
           daily_recommendations_id AS dailyRecommendationsId,
           first_published_at AS firstPublishedAt
         FROM recommendation_links
         WHERE url IN (${checkedUrls.map(() => '?').join(', ')})
           AND daily_recommendations_id <> ?
         ORDER BY first_published_at DESC`,
      ).bind(...checkedUrls, currentDailyRecommendationsId).all()
      return textResult({
        checkedUrls,
        previouslyPublished: RecommendationLinkHistoryRowSchema.array().parse(result.results),
      })
    },
    label: 'Checking recommendation links',
    name: 'check_recommendation_links',
    parameters: RecommendationLinkCheckParameters,
  }
}

export function recommendationLinkUpsertStatements(
  db: D1Database,
  dailyRecommendations: DailyRecommendations,
): D1PreparedStatement[] {
  return dailyRecommendations.links.map((link, index) => {
    const url = recommendationLinkKey(link.url)
    if (!url) throw new Error(`RecommendationLinkInvalid:${index}`)
    return db.prepare(
      `INSERT INTO recommendation_links
      (url, daily_recommendations_id, title, description, preview_image_url, first_published_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       preview_image_url = excluded.preview_image_url
     WHERE recommendation_links.daily_recommendations_id = excluded.daily_recommendations_id`,
    ).bind(
      url,
      dailyRecommendations.id,
      link.title,
      link.description,
      link.previewImageUrl ?? null,
      dailyRecommendations.publishedAt,
    )
  })
}
