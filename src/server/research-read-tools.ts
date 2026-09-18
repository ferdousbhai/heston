import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'

import { CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { equitySymbolsFromModelText, EquitySymbolSchema, ModelTextEquitySymbolType } from '../domain/instrument'
import { type DailyRecommendations } from '../domain/market'
import { type AppEnv } from './env'
import { textResult } from './agent-tool-result'
import { MAX_MARKET_SYMBOLS } from './brokerage-read-contracts'
import { readLatestDailyRecommendations } from './daily-recommendations-store'

// A catalyst call shares the normal market-read batch budget. The row ceiling is a model-context
// budget and is observable through `truncated`; the one-year horizon keeps "upcoming" scheduled
// events actionable. The agent can issue a narrower follow-up instead of receiving an archive.
const MAX_CATALYST_SYMBOLS = MAX_MARKET_SYMBOLS
/**
 * Measured, not guessed: a stored row with its title, description and source URL serializes to
 * roughly 350 characters, so sixty rows is about 21,000 characters -- some 5,000 tokens of the
 * caller's turn, which is what one read of a shared calendar is worth. A hundred rows was two
 * and a half times that for the same twenty symbols, and the rows past the sixtieth are the
 * furthest out and least actionable. `truncated` still says when the horizon held more.
 */
const MAX_CATALYSTS = 60
const MAX_CATALYST_HORIZON_DAYS = 365

const CatalystReadParameters = Type.Object({
  horizonDays: Type.Optional(Type.Integer({
    description: 'Calendar days ahead; default 90.',
    maximum: MAX_CATALYST_HORIZON_DAYS,
    minimum: 1,
  })),
  symbols: Type.Array(ModelTextEquitySymbolType, {
    maxItems: MAX_CATALYST_SYMBOLS,
    minItems: 1,
  }),
}, { additionalProperties: false })

const DailyRecommendationsReadParameters = Type.Object({}, { additionalProperties: false })

/**
 * What the agent is handed is a projection of the stored row, not the row: a catalyst `id` is
 * `<producer>:<symbol>:<kind>:<date>`, every part of which is already a field beside it, and no
 * tool on this surface accepts one as input -- so it is roughly fifty characters per row that
 * buys the reader nothing. The domain `CatalystSchema` keeps `id`, because the website orders,
 * de-duplicates and links by it; only this projection drops it.
 */
export type AgentCatalyst = Omit<Catalyst, 'id'>

function agentCatalyst(catalyst: Catalyst): AgentCatalyst {
  const { id: _id, ...row } = catalyst
  return row
}

export type CatalystReadResult = {
  catalysts: AgentCatalyst[]
  fetchedAt: string
  horizonDays: number
  source: 'spice-catalyst-store'
  symbols: string[]
  truncated: boolean
}

export type DailyRecommendationsReadResult = {
  fetchedAt: string
  source: 'spice-recommendation-store'
} & ({ dailyRecommendations: DailyRecommendations; status: 'ok' } | { status: 'not_found' })

function endDate(start: string, horizonDays: number): string {
  const [year, month, day] = start.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day! + horizonDays))
  return date.toISOString().slice(0, 10)
}

export async function readCatalysts(
  env: AppEnv,
  requestedSymbols: readonly string[],
  horizonDays = 90,
  now = new Date(),
): Promise<CatalystReadResult> {
  if (!env.DB) throw new Error('Catalyst data is unavailable.')
  if (!requestedSymbols.length || requestedSymbols.length > MAX_CATALYST_SYMBOLS) {
    throw new Error('Catalyst symbols are invalid.')
  }
  const normalized: string[] = []
  for (const symbol of requestedSymbols) {
    const parsed = EquitySymbolSchema.safeParse(symbol).data
    if (!parsed || parsed !== symbol) throw new Error('Catalyst symbols are invalid.')
    normalized.push(parsed)
  }
  const symbols = [...new Set(normalized)]
  const boundedHorizon = Math.trunc(horizonDays)
  if (boundedHorizon < 1 || boundedHorizon > MAX_CATALYST_HORIZON_DAYS) {
    throw new Error('Catalyst horizon is invalid.')
  }
  const start = marketDate(now)
  const result = await env.DB.prepare(
    `SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
      source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"
     FROM upcoming_catalysts
     WHERE symbol IN (${symbols.map(() => '?').join(', ')})
       AND event_date BETWEEN ? AND ?
     ORDER BY event_date ASC, symbol ASC
     LIMIT ?`,
  ).bind(...symbols, start, endDate(start, boundedHorizon), MAX_CATALYSTS + 1).all()
  if (!Array.isArray(result.results)) throw new Error('Catalyst data returned an invalid response.')
  const allCatalysts = CatalystSchema.array().parse(result.results)
  const catalysts = allCatalysts.slice(0, MAX_CATALYSTS).map(agentCatalyst)
  return {
    catalysts,
    fetchedAt: now.toISOString(),
    horizonDays: boundedHorizon,
    source: 'spice-catalyst-store',
    symbols,
    truncated: allCatalysts.length > catalysts.length,
  }
}

export async function readLatestDailyRecommendationsState(
  env: AppEnv,
  now = new Date(),
): Promise<DailyRecommendationsReadResult> {
  if (!env.DB) throw new Error('Daily research is unavailable.')
  const dailyRecommendations = await readLatestDailyRecommendations(env.DB)
  if (!dailyRecommendations) {
    return { fetchedAt: now.toISOString(), source: 'spice-recommendation-store', status: 'not_found' }
  }
  return {
    dailyRecommendations,
    fetchedAt: now.toISOString(),
    source: 'spice-recommendation-store',
    status: 'ok',
  }
}

export function createResearchReadTools(env: AppEnv, now = new Date()) {
  const catalysts: AgentTool<typeof CatalystReadParameters, CatalystReadResult | { error: string }> = {
    description: 'Stored upcoming catalysts; excludes dividends.',
    execute: async (_toolCallId, params) => {
      const parsed = equitySymbolsFromModelText(params.symbols)
      if ('unreadable' in parsed) return textResult({ error: `not a ticker symbol: ${parsed.unreadable.slice(0, 12)}` })
      return textResult(await readCatalysts(env, parsed.symbols, params.horizonDays, now))
    },
    label: 'Reading catalysts',
    name: 'read_catalysts',
    parameters: CatalystReadParameters,
  }
  const dailyRecommendations: AgentTool<
    typeof DailyRecommendationsReadParameters,
    DailyRecommendationsReadResult
  > = {
    description: 'Latest stored daily recommendations, including their reader links.',
    execute: async () => textResult(await readLatestDailyRecommendationsState(env, now)),
    label: 'Reading daily recommendations',
    name: 'read_daily_recommendations',
    parameters: DailyRecommendationsReadParameters,
  }
  return [catalysts, dailyRecommendations]
}
