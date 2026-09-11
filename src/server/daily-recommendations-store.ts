import { z } from 'zod'

import {
  parseStoredDailyRecommendations,
  DailyRecommendationsSchema,
  type DailyRecommendations,
} from '../domain/market'

const StoredDailyRecommendationsRowSchema = z.object({ payload_json: z.string() })

/** The store owns only persistence shape; callers retain their audience-specific absence policy. */
export async function readLatestDailyRecommendations(db: D1Database): Promise<DailyRecommendations | undefined> {
  const result = await db.prepare(
    'SELECT payload_json FROM daily_recommendations ORDER BY published_at DESC LIMIT 1',
  ).first()
  if (!result) return undefined
  const row = StoredDailyRecommendationsRowSchema.parse(result)
  return parseStoredDailyRecommendations(JSON.parse(row.payload_json))
}

/** Read one archive neighbor so the public UI can traverse history without an unbounded payload. */
export async function readDailyRecommendationsBefore(
  db: D1Database,
  publishedBefore: string,
): Promise<DailyRecommendations | undefined> {
  const result = await db.prepare(
    `SELECT payload_json FROM daily_recommendations
     WHERE published_at < ?
     ORDER BY published_at DESC
     LIMIT 1`,
  ).bind(publishedBefore).first()
  if (!result) return undefined
  const row = StoredDailyRecommendationsRowSchema.parse(result)
  return parseStoredDailyRecommendations(JSON.parse(row.payload_json))
}

export function dailyRecommendationsUpsertStatement(
  db: D1Database,
  dailyRecommendations: DailyRecommendations,
): D1PreparedStatement {
  const stored = DailyRecommendationsSchema.parse(dailyRecommendations)
  return db.prepare(
    `INSERT INTO daily_recommendations (id, published_at, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, payload_json = excluded.payload_json`,
  ).bind(stored.id, stored.publishedAt, JSON.stringify(stored))
}
