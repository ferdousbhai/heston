import { z } from 'zod'

import { marketDate } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import { dailyRecommendationsId } from './research-contracts'

// Prior daily recommendations are a deduplication aid, not an archive-search tool; one year bounds
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
 * Read only requested tickers from the model-selected recent-recommendation window. The ticker
 * list is one JSON-bound value, so the query stays static without a product-level cap.
 *
 * The current market date's own recommendations are excluded. A rerun replaces that row, so
 * without this a second run of the same day reads the morning's output as prior
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
       daily.published_at,
       json_extract(recommendation.value, '$.symbol') AS symbol,
       json_extract(recommendation.value, '$.direction') AS direction,
       json_extract(recommendation.value, '$.headline') AS headline,
       json_extract(recommendation.value, '$.description') AS description,
       json_extract(recommendation.value, '$.risk') AS risk
     FROM daily_recommendations AS daily,
          json_each(daily.payload_json, '$.recommendations') AS recommendation
     WHERE daily.published_at >= ?
       AND daily.published_at < ?
       AND daily.id <> ?
       AND json_extract(recommendation.value, '$.symbol') IN (SELECT value FROM json_each(?))
     ORDER BY daily.published_at DESC`,
  ).bind(
    coverageCutoff(now, daysAgo),
    now.toISOString(),
    dailyRecommendationsId(marketDate(now)),
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
