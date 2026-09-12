import { z } from 'zod'

import {
  parseStoredDailyRecommendations,
  DailyRecommendationsSchema,
  RecommendationVerificationSchema,
  type DailyRecommendations,
  type RecommendationVerification,
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

/**
 * Only the instant, for the publish boundary's refresh gate: it needs no payload, and parsing
 * one would let an old row that no longer fits the contract stand between a member and a
 * fresh brief.
 */
export async function readLatestDailyRecommendationsPublishedAt(db: D1Database): Promise<string | undefined> {
  const row = await db.prepare(
    'SELECT published_at FROM daily_recommendations ORDER BY published_at DESC LIMIT 1',
  ).first<{ published_at: string }>()
  return row?.published_at
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

/**
 * `publishedByUserId` is the account behind the publication and is required of every caller:
 * the column is nullable only for briefs that predate it. It is written and never read back
 * out of here — no route, tool, or public read selects it, and the payload the site serves
 * carries the member's chosen byline instead.
 */
export function dailyRecommendationsUpsertStatement(
  db: D1Database,
  dailyRecommendations: DailyRecommendations,
  publishedByUserId: string,
): D1PreparedStatement {
  const stored = DailyRecommendationsSchema.parse(dailyRecommendations)
  return db.prepare(
    `INSERT INTO daily_recommendations (id, published_at, payload_json, published_by_user_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at,
       payload_json = excluded.payload_json,
       published_by_user_id = excluded.published_by_user_id`,
  ).bind(stored.id, stored.publishedAt, JSON.stringify(stored), publishedByUserId)
}

/**
 * Record what a re-read of one recommendation's sources found, in the brief it was published
 * in. Deliberately not a re-publish: `json_set` touches the single verification path and
 * leaves `published_at`, the publisher, and every bound field exactly as the publish boundary
 * wrote them, so a brief cannot acquire content it was never verified with, and two challenges
 * of different symbols in the same brief cannot clobber one another the way a read-modify-write
 * of the whole payload would.
 *
 * The target is everything the caller read the recommendation at: a brief id repeats across a
 * republish of the same market date, so the statement also pins the instant that republish
 * would have moved and the symbol that must still sit at that index. A verification computed
 * against evidence that has since been replaced writes nothing and says so, rather than
 * labelling a recommendation with a check that was never run on it.
 */
export interface VerifiedRecommendation {
  briefId: string
  publishedAt: string
  recommendationIndex: number
  symbol: string
}

export async function writeRecommendationVerification(
  db: D1Database,
  target: VerifiedRecommendation,
  verification: RecommendationVerification,
): Promise<boolean> {
  if (!Number.isInteger(target.recommendationIndex) || target.recommendationIndex < 0) {
    throw new Error('DailyRecommendationsStore:invalid-recommendation-index')
  }
  const stored = RecommendationVerificationSchema.parse(verification)
  const result = await db.prepare(
    `UPDATE daily_recommendations
     SET payload_json = json_set(payload_json, ?, json(?))
     WHERE id = ? AND published_at = ? AND json_extract(payload_json, ?) = ?`,
  ).bind(
    `$.recommendations[${target.recommendationIndex}].verification`,
    JSON.stringify(stored),
    target.briefId,
    target.publishedAt,
    `$.recommendations[${target.recommendationIndex}].symbol`,
    target.symbol,
  ).run()
  return result.meta.changes > 0
}
