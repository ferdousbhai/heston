import { type DailyRecommendations } from '../domain/market'
import { recommendationLinkKey } from './research-url'

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
