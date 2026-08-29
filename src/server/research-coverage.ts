import { z } from 'zod'

import { marketDate } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'

const CoverageRowFields = {
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  published_at: z.string().datetime(),
  risk: z.string().min(1),
  symbol: EquitySymbolSchema,
}

const CurrentCoverageRowSchema = z.object({
  ...CoverageRowFields,
  description: z.string().min(1),
  headline: z.string().min(1),
  horizon: z.null(),
  setup: z.null(),
  thesis: z.null(),
}).transform((row) => ({ ...row, publishedAt: row.published_at }))

const LegacyCoverageRowSchema = z.object({
  ...CoverageRowFields,
  description: z.null(),
  headline: z.null(),
  horizon: z.string().min(1),
  setup: z.string().min(1),
  thesis: z.string().min(1),
}).transform((row) => ({
  ...row,
  description: `${row.thesis} Horizon: ${row.horizon}.`,
  headline: row.setup,
  publishedAt: row.published_at,
}))

const RecentCoverageRowSchema = z.union([CurrentCoverageRowSchema, LegacyCoverageRowSchema])

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
  if (!Number.isSafeInteger(daysAgo) || daysAgo < 1 || daysAgo > 365) {
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
       json_extract(idea.value, '$.risk') AS risk,
       json_extract(idea.value, '$.setup') AS setup,
       json_extract(idea.value, '$.thesis') AS thesis,
       json_extract(idea.value, '$.horizon') AS horizon
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
