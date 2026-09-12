import { z } from 'zod'

import { marketDate } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import { dailyRecommendationsId } from './research-contracts'

// Prior daily recommendations are a deduplication aid, not an archive-search tool; one year bounds
// the D1 scan and agent context while covering every seasonal comparison available to a daily run.
export const MAX_RESEARCH_LOOKBACK_DAYS = 365
/**
 * How many prior recommendations one lookback may return, newest first.
 *
 * The question this answers is whether a name was argued recently and on what case, so the
 * newest rows are the whole value and an exhaustive history is not. Until now there was no
 * bound at all, which the storage happened to make safe: a market date held one brief, so a
 * year of lookback was a year of rows. Nothing enforces that any more -- a brief is replaced
 * whenever a reader asks their own agent for one, and the refresh interval is only the floor
 * between two of them -- so how much prose this returns is now set by how busy the site was,
 * which is exactly the kind of ceiling a query should not be left without. A caller that hits
 * it narrows its tickers or its window, which `truncated` is what tells it to do.
 */
export const MAX_RECENT_COVERAGE_ROWS = 25

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

/** Newest first, and honest about the rest: a short list and a silently short list differ. */
export interface RecentCoverageResult {
  coverage: RecentTickerCoverage[]
  truncated: boolean
}

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
): Promise<RecentCoverageResult> {
  if (symbols.length === 0) return { coverage: [], truncated: false }
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
     ORDER BY daily.published_at DESC
     LIMIT ?`,
  ).bind(
    coverageCutoff(now, daysAgo),
    now.toISOString(),
    dailyRecommendationsId(marketDate(now)),
    JSON.stringify([...requested]),
    // One past the budget, so a full page is distinguishable from one that merely filled it.
    MAX_RECENT_COVERAGE_ROWS + 1,
  ).all()

  const parsed = rows.results.map((value) => {
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
  return {
    coverage: parsed.slice(0, MAX_RECENT_COVERAGE_ROWS),
    truncated: parsed.length > MAX_RECENT_COVERAGE_ROWS,
  }
}
