import { z } from 'zod'

import { DailyRecommendationsSchema, type DailyRecommendations } from '../domain/market'

const RecommendationArchiveResponseSchema = z.strictObject({
  dailyRecommendations: DailyRecommendationsSchema.nullable(),
})

export async function loadPreviousDailyRecommendations(
  publishedBefore: string,
  signal?: AbortSignal,
): Promise<DailyRecommendations | undefined> {
  const query = new URLSearchParams({ before: publishedBefore })
  const response = await fetch(`/api/public-daily-recommendations?${query}`, {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) throw new Error(`Recommendation archive request failed (${response.status})`)
  const result = RecommendationArchiveResponseSchema.parse(await response.json())
  return result.dailyRecommendations ?? undefined
}
