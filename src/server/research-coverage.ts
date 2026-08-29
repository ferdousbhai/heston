import { z } from 'zod'

import { marketDate } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import { researchBriefId } from './research-contracts'

const MAX_COVERAGE_PER_SYMBOL = 3
const MAX_COVERAGE_SYMBOLS = 20
const MAX_COVERAGE_ROWS = MAX_COVERAGE_PER_SYMBOL * MAX_COVERAGE_SYMBOLS

const RecentCoverageRowSchema = z.object({
  description: z.string().trim().min(1).max(360).nullable(),
  direction: z.enum(['bullish', 'bearish', 'neutral']),
  headline: z.string().trim().min(1).max(100).nullable(),
  horizon: z.string().trim().min(1).nullable(),
  published_at: z.string().datetime(),
  risk: z.string().trim().min(1).max(240),
  setup: z.string().trim().min(1).nullable(),
  symbol: EquitySymbolSchema,
  thesis: z.string().trim().min(1).nullable(),
})

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
 * Read only requested tickers from the recent-brief window, then retain the latest
 * three rows per symbol. The ticker list is one JSON-bound value, so the query stays
 * static and bounded without exposing entire historical briefs to the model.
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
  if (!env.DB || symbols.length === 0) return []
  if (!Number.isSafeInteger(daysAgo) || daysAgo < 1 || daysAgo > 365) {
    throw new Error('Recent coverage lookback is invalid.')
  }
  const requested = new Set(symbols.map((symbol) => EquitySymbolSchema.parse(symbol)))
  const rows = await env.DB.prepare(
    `WITH coverage AS (
       SELECT
         brief.published_at,
         json_extract(idea.value, '$.symbol') AS symbol,
         json_extract(idea.value, '$.direction') AS direction,
         json_extract(idea.value, '$.headline') AS headline,
         json_extract(idea.value, '$.description') AS description,
         json_extract(idea.value, '$.risk') AS risk,
         json_extract(idea.value, '$.setup') AS setup,
         json_extract(idea.value, '$.thesis') AS thesis,
         json_extract(idea.value, '$.horizon') AS horizon,
         row_number() OVER (
           PARTITION BY json_extract(idea.value, '$.symbol')
           ORDER BY brief.published_at DESC
         ) AS symbol_rank
       FROM research_briefs AS brief, json_each(brief.payload_json, '$.ideas') AS idea
       WHERE brief.published_at >= ?
         AND brief.published_at < ?
         AND brief.id <> ?
         AND json_extract(idea.value, '$.symbol') IN (SELECT value FROM json_each(?))
     )
     SELECT published_at, symbol, direction, headline, description, risk, setup, thesis, horizon
     FROM coverage
     WHERE symbol_rank <= ${MAX_COVERAGE_PER_SYMBOL}
     ORDER BY published_at DESC
     LIMIT ${MAX_COVERAGE_ROWS}`,
  ).bind(
    coverageCutoff(now, daysAgo),
    now.toISOString(),
    researchBriefId(marketDate(now)),
    JSON.stringify([...requested]),
  ).all()

  const perSymbol = new Map<string, number>()
  return rows.results.flatMap((value) => {
    const row = RecentCoverageRowSchema.safeParse(value).data
    if (!row || !requested.has(row.symbol)
      || (perSymbol.get(row.symbol) ?? 0) >= MAX_COVERAGE_PER_SYMBOL) return []
    const headline = row.headline ?? row.setup
    const description = row.description ?? (row.thesis && row.horizon
      ? `${row.thesis} Horizon: ${row.horizon}.`.slice(0, 360)
      : undefined)
    if (!headline || !description) return []
    perSymbol.set(row.symbol, (perSymbol.get(row.symbol) ?? 0) + 1)
    return [{
      description,
      direction: row.direction,
      headline,
      publishedAt: row.published_at,
      risk: row.risk,
      symbol: row.symbol,
    }]
  })
}
