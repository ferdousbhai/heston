import { z } from 'zod'

import { marketDate } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'

// Prior daily briefs are a deduplication aid, not an archive-search tool; one year bounds
// the D1 scan and agent context while covering every seasonal comparison available to a daily run.
export const MAX_RESEARCH_LOOKBACK_DAYS = 365

const CoverageRowFields = {
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  published_at: z.string().datetime(),
  risk: z.string().min(1),
  symbol: EquitySymbolSchema,
}

const RecentCoverageRowSchema = z.object({
  ...CoverageRowFields,
  description: z.string().min(1),
  headline: z.string().min(1),
}).transform((row) => ({ ...row, publishedAt: row.published_at }))

export interface RecentTickerCoverage {
  description: string
  direction: 'bullish' | 'bearish' | 'neutral'
  headline: string
  publishedAt: string
  risk: string
  symbol: string
}

function coverageCutoff(now: Date, daysAgo: number): string {
  return new Date(now.getTime() - daysAgo * 24 * 60 * 60_000).toISOString()
}

/**
 * Read only requested tickers from the model-selected recent-brief window. The ticker
 * list is one JSON-bound value, so the query stays static without a product-level cap.
 *
 * The current market date's own brief is excluded. A rerun replaces that row, so
 * without this a second run of the same day reads the morning's brief as prior
 * coverage and suppresses every symbol it just published as already covered.
 */
export async function searchRecentTickerCoverage(
  env: AppEnv,
  symbols: readonly string[],
  daysAgo = 14,
  now = new Date(),
): Promise<RecentTickerCoverage[]> {
  if (symbols.length === 0) return []
  if (!env.DB) throw new Error('RecentCoverageUnavailable')
  if (!Number.isSafeInteger(daysAgo) || daysAgo < 1 || daysAgo > MAX_RESEARCH_LOOKBACK_DAYS) {
    throw new Error('Recent coverage lookback is invalid.')
  }
  const requested = new Set(symbols.map((symbol) => EquitySymbolSchema.parse(symbol)))
  const rows = await env.DB.prepare(
    `SELECT
       brief.published_at,
       json_extract(idea.value, '$.symbol') AS symbol,
       json_extract(idea.value, '$.direction') AS direction,
       json_extract(idea.value, '$.headline') AS headline,
       json_extract(idea.value, '$.description') AS description,
       json_extract(idea.value, '$.risk') AS risk
     FROM research_briefs AS brief, json_each(brief.payload_json, '$.ideas') AS idea
     WHERE brief.published_at >= ?
       AND brief.published_at < ?
       AND brief.id <> ?
       AND json_extract(idea.value, '$.symbol') IN (SELECT value FROM json_each(?))
     ORDER BY brief.published_at DESC`,
  ).bind(
    coverageCutoff(now, daysAgo),
    now.toISOString(),
    researchBriefId(marketDate(now)),
    JSON.stringify([...requested]),
  ).all()

  return rows.results.map((value) => {
    const row = RecentCoverageRowSchema.parse(value)
    if (!requested.has(row.symbol)) throw new Error(`RecentCoverageUnexpectedSymbol:${row.symbol}`)
    return {
      description: row.description,
      direction: row.direction,
      headline: row.headline,
      publishedAt: row.publishedAt,
      risk: row.risk,
      symbol: row.symbol,
    }
  })
}
