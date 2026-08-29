import { z } from 'zod'

import {
  parseStoredResearchBrief,
  ResearchBriefSchema,
  type ResearchBrief,
} from '../domain/market'

const StoredResearchBriefRowSchema = z.object({ payload_json: z.string() })

/** The store owns only persistence shape; callers retain their audience-specific absence policy. */
export async function readLatestResearchBrief(db: D1Database): Promise<ResearchBrief | undefined> {
  const result = await db.prepare(
    'SELECT payload_json FROM research_briefs ORDER BY published_at DESC LIMIT 1',
  ).first()
  if (!result) return undefined
  const row = StoredResearchBriefRowSchema.parse(result)
  return parseStoredResearchBrief(JSON.parse(row.payload_json))
}

export async function upsertResearchBrief(db: D1Database, brief: ResearchBrief): Promise<void> {
  const stored = ResearchBriefSchema.parse(brief)
  await db.prepare(
    `INSERT INTO research_briefs (id, published_at, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, payload_json = excluded.payload_json`,
  ).bind(stored.id, stored.publishedAt, JSON.stringify(stored)).run()
}
