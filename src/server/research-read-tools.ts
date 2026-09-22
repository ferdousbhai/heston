import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'

import { CatalystSchema, distinctCatalysts, marketDate, type Catalyst } from '../domain/catalyst'
import { equitySymbolsFromModelText, EquitySymbolSchema, ModelTextEquitySymbolType } from '../domain/instrument'
import { type DailyBrief } from '../domain/brief'
import { type AppEnv } from './env'
import { textResult } from './agent-tool-result'
import { MAX_MARKET_SYMBOLS } from './brokerage-read-contracts'
import { CURRENT_CATALYSTS } from './catalysts'
import { readLatestDailyBrief } from './daily-brief-store'

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
  source: 'heston-catalyst-store'
  symbols: string[]
  truncated: boolean
}

function endDate(start: string, horizonDays: number): string {
  const [year, month, day] = start.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day! + horizonDays))
  return date.toISOString().slice(0, 10)
}

const BriefReadParameters = Type.Object({}, { additionalProperties: false })

export type DailyBriefReadResult = {
  fetchedAt: string
  source: 'heston-brief-store'
} & ({ brief: DailyBrief; status: 'ok' } | { status: 'not_found' })

export async function readLatestDailyBriefState(env: AppEnv, now = new Date()): Promise<DailyBriefReadResult> {
  if (!env.DB) throw new Error('Daily brief is unavailable.')
  const brief = await readLatestDailyBrief(env.DB)
  const fetchedAt = now.toISOString()
  return brief ? { brief, fetchedAt, source: 'heston-brief-store', status: 'ok' } : { fetchedAt, source: 'heston-brief-store', status: 'not_found' }
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
     FROM ${CURRENT_CATALYSTS}
     WHERE symbol IN (${symbols.map(() => '?').join(', ')})
       AND event_date BETWEEN ? AND ?
     ORDER BY event_date ASC, symbol ASC
     LIMIT ?`,
  ).bind(...symbols, start, endDate(start, boundedHorizon), MAX_CATALYSTS + 1).all()
  if (!Array.isArray(result.results)) throw new Error('Catalyst data returned an invalid response.')
  const allCatalysts = CatalystSchema.array().parse(result.results)
  // Truncation is judged on the rows the query returned, before one event's several sightings
  // fold into one: folding says nothing about what the ceiling left behind, and a reader told
  // it has the whole calendar when it does not is the one wrong answer here.
  const truncated = allCatalysts.length > MAX_CATALYSTS
  const catalysts = distinctCatalysts(allCatalysts).slice(0, MAX_CATALYSTS).map(agentCatalyst)
  return {
    catalysts,
    fetchedAt: now.toISOString(),
    horizonDays: boundedHorizon,
    source: 'heston-catalyst-store',
    symbols,
    truncated,
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
  const brief: AgentTool<typeof BriefReadParameters, DailyBriefReadResult> = {
    description: 'The standing daily brief: trade lines, theses and the day\'s links, as the site shows them.',
    execute: async () => textResult(await readLatestDailyBriefState(env, now)),
    label: 'Reading the daily brief',
    name: 'read_daily_brief',
    parameters: BriefReadParameters,
  }
  return [catalysts, brief]
}
