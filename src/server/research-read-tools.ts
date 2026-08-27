import { Type } from '@earendil-works/pi-ai'
import { type AgentTool } from '@earendil-works/pi-agent-core'

import { CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { EQUITY_SYMBOL_PATTERN, EquitySymbolSchema } from '../domain/instrument'
import { type JsonValue } from '../domain/json-payload'
import { parseStoredResearchBrief, type ResearchBrief } from '../domain/market'
import { type AppEnv } from './env'

const MAX_CATALYST_SYMBOLS = 20
const MAX_CATALYSTS = 100

const CatalystReadParameters = Type.Object({
  horizonDays: Type.Optional(Type.Integer({
    description: 'Number of calendar days ahead to search. Defaults to 90.',
    maximum: 365,
    minimum: 1,
  })),
  symbols: Type.Array(Type.String({ pattern: EQUITY_SYMBOL_PATTERN }), {
    description: 'One or more exact equity ticker symbols.',
    maxItems: MAX_CATALYST_SYMBOLS,
    minItems: 1,
  }),
}, { additionalProperties: false })

const DailyResearchReadParameters = Type.Object({}, { additionalProperties: false })

export type CatalystReadResult = {
  catalysts: Catalyst[]
  fetchedAt: string
  horizonDays: number
  source: 'spice-catalyst-store'
  symbols: string[]
  truncated: boolean
}

export type DailyResearchReadResult = {
  brief: ResearchBrief | null
  fetchedAt: string
  source: 'spice-research-store'
  status: 'ok' | 'not_found'
}

function endDate(start: string, horizonDays: number): string {
  const [year, month, day] = start.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day! + horizonDays))
  return date.toISOString().slice(0, 10)
}

/** Read only option-relevant catalysts. */
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
  if (boundedHorizon < 1 || boundedHorizon > 365) throw new Error('Catalyst horizon is invalid.')
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
  const catalysts = allCatalysts.slice(0, MAX_CATALYSTS)
  return {
    catalysts,
    fetchedAt: now.toISOString(),
    horizonDays: boundedHorizon,
    source: 'spice-catalyst-store',
    symbols,
    truncated: allCatalysts.length > catalysts.length,
  }
}

export async function readLatestResearch(
  env: AppEnv,
  now = new Date(),
): Promise<DailyResearchReadResult> {
  if (!env.DB) throw new Error('Daily research is unavailable.')
  const row = await env.DB.prepare(
    'SELECT payload_json FROM research_briefs ORDER BY published_at DESC LIMIT 1',
  ).first<{ payload_json: string }>()
  if (!row) {
    return { brief: null, fetchedAt: now.toISOString(), source: 'spice-research-store', status: 'not_found' }
  }
  let payload: JsonValue
  try {
    payload = JSON.parse(row.payload_json)
  } catch {
    throw new Error('Daily research returned an invalid response.')
  }
  const brief = parseStoredResearchBrief(payload)
  return { brief, fetchedAt: now.toISOString(), source: 'spice-research-store', status: 'ok' }
}

export function createResearchReadTools(env: AppEnv) {
  const catalysts: AgentTool<typeof CatalystReadParameters, CatalystReadResult> = {
    description: 'Read upcoming earnings and other material scheduled catalysts for exact symbols from Spice. Dividends are excluded. This is read-only and should be called only when catalyst timing matters.',
    execute: async (_toolCallId, params) => {
      const result = await readCatalysts(env, params.symbols, params.horizonDays)
      return { content: [{ text: JSON.stringify(result), type: 'text' }], details: result }
    },
    executionMode: 'sequential',
    label: 'Reading catalysts',
    name: 'read_catalysts',
    parameters: CatalystReadParameters,
  }
  const research: AgentTool<typeof DailyResearchReadParameters, DailyResearchReadResult> = {
    description: 'Read the latest stored Spice daily market research brief. This is read-only; call it only when the user asks about today’s research, trade ideas, regime, or news review.',
    execute: async () => {
      const result = await readLatestResearch(env)
      return { content: [{ text: JSON.stringify(result), type: 'text' }], details: result }
    },
    executionMode: 'sequential',
    label: 'Reading daily research',
    name: 'read_daily_research',
    parameters: DailyResearchReadParameters,
  }
  return [catalysts, research]
}
