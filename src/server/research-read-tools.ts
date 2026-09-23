import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'
import { z } from 'zod'

import { CATALYST_HORIZON_DAYS, CatalystSchema, distinctCatalysts, marketDate, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema, ModelTextEquitySymbolType } from '../domain/instrument'
import { tickerSymbolsArgument } from './ticker-arguments'
import { type DailyBrief } from '../domain/brief'
import { addDays } from '../domain/iso-date'
import { type AppEnv } from './env'
import { textResult } from './agent-tool-result'
import { MAX_MARKET_SYMBOLS } from './brokerage-read-contracts'
import { CATALYST_RUN_BUDGET_MS } from './catalyst-refresh'
import { CURRENT_CATALYSTS } from './catalysts'
import { readLatestDailyBrief } from './daily-brief-store'
import { CallerVisibleError } from './caller-visible-error'

// A catalyst call shares the normal market-read batch budget. The row ceiling is a model-context
// budget and is observable through `truncated`. The horizon is the store's own: no research producer may
// write an event past `CATALYST_HORIZON_DAYS`, so a wider read could only ever return the same
// rows, and an omitted horizon asks for all of them. The agent can narrow it for a follow-up.
const MAX_CATALYST_SYMBOLS = MAX_MARKET_SYMBOLS
/**
 * Measured, not guessed: a stored row with its title, description and source URL serializes to
 * roughly 350 characters, so sixty rows is about 21,000 characters -- some 5,000 tokens of the
 * caller's turn, which is what one read of a shared calendar is worth. A hundred rows was two
 * and a half times that for the same twenty symbols, and the rows past the sixtieth are the
 * furthest out and least actionable. `truncated` still says when the horizon held more.
 */
const MAX_CATALYSTS = 60

const CatalystReadParameters = Type.Object({
  horizonDays: Type.Optional(Type.Integer({
    description: `Calendar days ahead; default and maximum ${CATALYST_HORIZON_DAYS}.`,
    maximum: CATALYST_HORIZON_DAYS,
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

/**
 * Where the site's own catalyst search stands for one requested symbol, read from its receipt in
 * `catalyst_runs`. An empty calendar means nothing on its own: a name nobody has looked at has no
 * receipt (`unsearched`), and a name whose search came back empty has a `complete` one. `failed`
 * is a search that bound nothing, so its calendar is still unknown; `running` is a claimed search
 * still inside its run budget. A `running` receipt past that budget is a run that died mid-flight,
 * and only a new claim rewrites it, so it reads as `failed` here rather than as a search in flight.
 *
 * Only the state and the instant cross this boundary. The receipt's `detail` is a failure note
 * written for the owner's eyes and never leaves the server, and nothing here is per-caller, so the
 * same answer is safe for every tier that can call the tool.
 */
export type CatalystSearchState =
  | { state: 'unsearched'; symbol: string }
  | { ranAt: string; state: 'complete' | 'failed' | 'running'; symbol: string }

const CatalystRunRowSchema = z.object({
  ranAt: z.string().datetime(),
  state: z.enum(['complete', 'failed', 'running']),
  symbol: z.string(),
})

export type CatalystReadResult = {
  catalysts: AgentCatalyst[]
  fetchedAt: string
  horizonDays: number
  /** One entry per requested symbol, in the order of `symbols`. */
  searches: CatalystSearchState[]
  source: 'heston-catalyst-store'
  symbols: string[]
  truncated: boolean
}

const BriefReadParameters = Type.Object({}, { additionalProperties: false })

export type DailyBriefReadResult = {
  fetchedAt: string
  source: 'heston-brief-store'
} & ({ brief: DailyBrief; status: 'ok' } | { status: 'not_found' })

async function readLatestDailyBriefState(env: AppEnv, now = new Date()): Promise<DailyBriefReadResult> {
  if (!env.DB) throw new CallerVisibleError('Daily brief is unavailable.')
  const brief = await readLatestDailyBrief(env.DB)
  const fetchedAt = now.toISOString()
  return brief ? { brief, fetchedAt, source: 'heston-brief-store', status: 'ok' } : { fetchedAt, source: 'heston-brief-store', status: 'not_found' }
}

export async function readCatalysts(
  env: AppEnv,
  requestedSymbols: readonly string[],
  horizonDays = CATALYST_HORIZON_DAYS,
  now = new Date(),
): Promise<CatalystReadResult> {
  if (!env.DB) throw new CallerVisibleError('Catalyst data is unavailable.')
  if (!requestedSymbols.length || requestedSymbols.length > MAX_CATALYST_SYMBOLS) {
    throw new CallerVisibleError('Catalyst symbols are invalid.')
  }
  const normalized: string[] = []
  for (const symbol of requestedSymbols) {
    const parsed = EquitySymbolSchema.safeParse(symbol).data
    if (!parsed || parsed !== symbol) throw new CallerVisibleError('Catalyst symbols are invalid.')
    normalized.push(parsed)
  }
  const symbols = [...new Set(normalized)]
  // Refused rather than rounded: a caller that sent 30.5 asked for something this read does not
  // answer, and quietly answering a different question is the failure to avoid.
  if (!Number.isInteger(horizonDays) || horizonDays < 1 || horizonDays > CATALYST_HORIZON_DAYS) {
    throw new CallerVisibleError('Catalyst horizon is invalid.')
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
  ).bind(...symbols, start, addDays(start, horizonDays), MAX_CATALYSTS + 1).all()
  if (!Array.isArray(result.results)) throw new CallerVisibleError('Catalyst data returned an invalid response.')
  const allCatalysts = CatalystSchema.array().parse(result.results)
  // Truncation is judged on the rows the query returned, before one event's several sightings
  // fold into one: folding says nothing about what the ceiling left behind, and a reader told
  // it has the whole calendar when it does not is the one wrong answer here.
  const truncated = allCatalysts.length > MAX_CATALYSTS
  const catalysts = distinctCatalysts(allCatalysts).slice(0, MAX_CATALYSTS).map(agentCatalyst)
  // The receipts of the one producer that answers for a whole symbol. `detail` is not selected.
  const runs = await env.DB.prepare(
    `SELECT symbol, status AS state, ran_at AS "ranAt"
     FROM catalyst_runs
     WHERE source_provider = 'exa' AND symbol IN (${symbols.map(() => '?').join(', ')})`,
  ).bind(...symbols).all()
  if (!Array.isArray(runs.results)) throw new CallerVisibleError('Catalyst data returned an invalid response.')
  const receipts = new Map(CatalystRunRowSchema.array().parse(runs.results).map((run) => [run.symbol, run]))
  const abandonedBefore = new Date(now.getTime() - CATALYST_RUN_BUDGET_MS).toISOString()
  const searches = symbols.map((symbol): CatalystSearchState => {
    const run = receipts.get(symbol)
    if (!run) return { state: 'unsearched', symbol }
    const state = run.state === 'running' && run.ranAt <= abandonedBefore ? 'failed' : run.state
    return { ranAt: run.ranAt, state, symbol }
  })
  return {
    catalysts,
    fetchedAt: now.toISOString(),
    horizonDays,
    searches,
    source: 'heston-catalyst-store',
    symbols,
    truncated,
  }
}

/** Each call reads the clock itself: a tool list is built once and answers for many calls. */
export function createResearchReadTools(env: AppEnv) {
  const catalysts: AgentTool<typeof CatalystReadParameters> = {
    description: 'Stored upcoming catalysts; excludes dividends. `searches` says, per symbol, whether '
      + 'the site\'s own search has run: unsearched, running, complete (an empty calendar is a real '
      + 'answer) or failed (still unknown).',
    execute: async (params) => textResult(
      await readCatalysts(env, tickerSymbolsArgument(params.symbols), params.horizonDays, new Date()),
    ),
    name: 'read_catalysts',
    parameters: CatalystReadParameters,
  }
  const brief: AgentTool<typeof BriefReadParameters> = {
    description: 'The standing daily brief: trade lines, theses and the day\'s links, as the site shows them.',
    execute: async () => textResult(await readLatestDailyBriefState(env, new Date())),
    name: 'read_daily_brief',
    parameters: BriefReadParameters,
  }
  return [catalysts, brief]
}
