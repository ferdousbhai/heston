import { z } from 'zod'

import { aiGatewayHeaders, grokGatewayBaseUrl } from './ai-gateway'
import { CatalystKindSchema, CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import { type AppEnv } from './env'
import { readBoundedJson } from './bounded-response'
import { JsonArraySchema, jsonObject, jsonObjectOrEmpty, type JsonValue } from '../domain/json-payload'
import { readStoredSecret } from './secrets'
import { persistResearchedCatalysts } from './catalysts'
import { defineSeam, type SeamValue } from './seam'

const MODEL = 'grok-4.6'
const SOURCE = 'Grok 4.6 X research'
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_SYMBOLS = 40

const CATALYST_HORIZON_DAYS = 180

/**
 * How far back the X Search corpus reaches, measured in post publication dates.
 *
 * `x_search`'s `from_date` and `to_date` bound when a post was *published*; they say
 * nothing about when the event a post announces takes place
 * (https://docs.x.ai/developers/tools/x-search). This window was three days long, which
 * asked Grok for something that cannot exist: a catalyst scheduled inside the forward
 * horizon was announced before it happens, usually weeks or months earlier, so the
 * announcing post almost never fell inside a three-day corpus. Grok answered correctly
 * and emitted nothing, every run. The corpus now spans the same length as the forward
 * horizon it has to cover, and the prompt states both windows separately so the model
 * never reads the publication bound as an event bound.
 */
const SEARCH_LOOKBACK_DAYS = 180

/**
 * Grok plans its own X searches, so a 40-symbol sweep is minutes of provider work, and the
 * whole daily job waits on it. This ceiling keeps a slow sweep inside the Cron invocation
 * budget while leaving real headroom above the longest sweeps observed in production.
 */
const REQUEST_TIMEOUT_MS = 7 * 60_000

const MAX_CITATION_NODES = 50_000

// Research only the maintained private list; public projections and current
// account positions never widen the model's scope.
export function catalystResearchSymbols(watchlists: readonly { kind: string; symbols: readonly string[] }[]): string[] {
  return [...new Set(watchlists
    .filter((watchlist) => watchlist.kind === 'private')
    .flatMap((watchlist) => watchlist.symbols.map((symbol) => symbol.toUpperCase())))]
    .slice(0, MAX_SYMBOLS)
}

/**
 * Grok writes inline citations as `[[1]](https://x.com/...)` markdown directly into the
 * response text, and on the Responses API that is the default
 * (https://docs.x.ai/developers/tools/citations). The findings JSON now arrives fenced
 * inside ordinary prose, so a marker can land inside a title or description as easily as
 * in the surrounding sentences. The request asks for them to be suppressed, and this
 * strips whatever arrives anyway, because the cost of missing one is not cosmetic: a
 * marker pushes a description past its 500-character bound, and that failure throws out
 * the entire sweep rather than the single finding it damaged.
 */
function withoutInlineCitations(value: string): string {
  return value.replace(/\[\[\d+\]\](?:\([^\s)]*\))?/g, '').replace(/[ \t]{2,}/g, ' ')
}

function cleanedModelProseSchema(max: number) {
  return z.string().transform(withoutInlineCitations).pipe(z.string().trim().min(1).max(max))
}

const FindingSchema = z.object({
  symbol: z.string(),
  kind: CatalystKindSchema.exclude(['earnings']),
  title: cleanedModelProseSchema(160),
  description: cleanedModelProseSchema(500),
  date: z.string(),
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  confidence: z.enum(['confirmed', 'estimated']),
  sourceUrl: z.string(),
})

const FindingsSchema = z.object({ findings: z.array(FindingSchema).max(100) })

const VerbatimModelTextSchema = z.string()

export type XCatalystResult = { catalysts: Catalyst[]; rejected: number }

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function canonicalXPostUrl(value: JsonValue): string | undefined {
  const raw = VerbatimModelTextSchema.safeParse(value).data
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return undefined
    if (!/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status\/\d+$/.test(url.pathname)) return undefined
    return `https://x.com${url.pathname}`
  } catch {
    return undefined
  }
}

/**
 * Walk one payload node, adding every X status URL the provider reported beneath it.
 * `cited` marks the positions the provider uses for source URLs: a `url` field, and any
 * member of a `citations` list, whether that list holds bare URL strings or objects.
 */
function collectCitationUrls(
  value: JsonValue,
  cited: boolean,
  urls: Set<string>,
  budget: { nodes: number },
): void {
  if (budget.nodes <= 0) return
  budget.nodes -= 1
  const items = JsonArraySchema.safeParse(value).data
  if (items) {
    for (const item of items) collectCitationUrls(item, cited, urls, budget)
    return
  }
  const object = jsonObject(value)
  if (object) {
    for (const [key, child] of Object.entries(object)) {
      collectCitationUrls(child, key === 'url' || key === 'citations', urls, budget)
    }
    return
  }
  if (!cited) return
  const url = canonicalXPostUrl(value)
  if (url) urls.add(url)
}

/**
 * Every X status URL the provider itself reported, wherever this payload carries it.
 *
 * The Responses API carries citations as `url_citation` annotations on message content
 * (https://docs.x.ai/developers/tools/citations); the flat `citations` list belongs to
 * chat completions and the xAI SDK, and `x_search` result URLs have no `include` option
 * that returns them as tool output at all. The old reader hardcoded one path per shape,
 * so any payload arranged even slightly differently produced an empty trusted set and
 * every finding was dropped. This walk reads any `url` field and any `citations` member
 * wherever it sits, which also covers `x_search` surfacing as a `custom_tool_call` rather
 * than the `x_search_call` item type the docs name.
 *
 * The set stays trusted because model prose never reaches it. The model's only output
 * channel is one opaque string inside an `output_text` block, so a model-authored
 * `sourceUrl` — or any URL it writes into the surrounding prose — is characters inside
 * that string and never a traversable `url` field of its own; a finding still has to
 * match a URL the provider put in the payload.
 */
function citationUrls(payload: JsonValue): Set<string> {
  const urls = new Set<string>()
  collectCitationUrls(payload, false, urls, { nodes: MAX_CITATION_NODES })
  return urls
}

function outputText(payload: JsonValue): string | undefined {
  for (const item of (JsonArraySchema.safeParse(jsonObjectOrEmpty(payload).output).data ?? []).map(jsonObjectOrEmpty)) {
    for (const content of (JsonArraySchema.safeParse(item.content).data ?? []).map(jsonObjectOrEmpty)) {
      const text = VerbatimModelTextSchema.safeParse(content.text).data
      if (content.type === 'output_text' && text !== undefined) return text
    }
  }
  return undefined
}

/**
 * How many X searches the provider reports it actually ran. Grok chooses on its own
 * whether to search, so this is the one field that separates "searched and the window
 * held nothing" from "answered from memory", and a barren run cannot be read without it.
 */
function xSearchCalls(payload: JsonValue): number | undefined {
  const usage = jsonObjectOrEmpty(jsonObjectOrEmpty(payload).usage)
  const details = jsonObjectOrEmpty(usage.server_side_tool_usage_details)
  return z.number().safeParse(details.x_search_calls).data
}

/**
 * The findings document, lifted out of an ordinary answer.
 *
 * This request cannot ask for structured output: a strict `json_schema` response format
 * suppresses server-side tool invocation on Grok, so the model answered from parametric
 * memory — zero searches, zero citations, zero findings, every run — and `tool_choice:
 * 'required'` did not change that. The model now writes prose and fences the JSON inside
 * it, which is the same shape `research-output.ts` reads (kept local so this module stays
 * self-contained). Candidates are tried in order of how deliberate they are: each fenced
 * block, then the whole answer for a bare document, then the outermost braces for a
 * document announced in a sentence. `FindingsSchema` is still the only gate — an
 * unparseable answer throws rather than passing an empty sweep off as a real one.
 */
function findingsJson(text: string): JsonValue {
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1] ?? '')
  const braced = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  for (const candidate of [...fenced, text, braced]) {
    if (!candidate.trim()) continue
    try {
      return JSON.parse(candidate)
    } catch {
      continue
    }
  }
  throw new Error('XCatalystResponse:unparsable-findings')
}

export function parseXCatalystResponse(
  payload: JsonValue,
  allowedSymbols: readonly string[],
  now = new Date(),
): XCatalystResult & { citations: number; searches: number | undefined } {
  const text = outputText(payload)
  if (!text) throw new Error('XCatalystResponse:missing-output')
  const findings = FindingsSchema.parse(findingsJson(text)).findings
  const citations = citationUrls(payload)
  const symbols = new Set(allowedSymbols.map((symbol) => symbol.toUpperCase()))
  const today = marketDate(now)
  const horizon = addDays(today, CATALYST_HORIZON_DAYS)
  const accepted = new Map<string, Catalyst>()
  for (const finding of findings) {
    const symbol = finding.symbol.toUpperCase()
    const sourceUrl = canonicalXPostUrl(finding.sourceUrl)
    if (!symbols.has(symbol) || !isValidIsoDate(finding.date) || finding.date < today || finding.date > horizon || !sourceUrl || !citations.has(sourceUrl)) {
      continue
    }
    const id = `xai-x-search:${symbol}:${finding.kind}:${finding.date}`
    const catalyst = CatalystSchema.parse({ ...finding, id, symbol, sourceUrl, source: SOURCE, updatedAt: now.toISOString() })
    const current = accepted.get(id)
    if (!current || (current.confidence === 'estimated' && catalyst.confidence === 'confirmed')) accepted.set(id, catalyst)
  }
  // Everything the loop did not accept, which counts findings dropped by the
  // guards and duplicates collapsed onto an existing id alike. Search and citation
  // counts travel alongside it because the run row records a barren sweep as a bare
  // zero, which on its own cannot say whether the sweep searched X at all.
  return {
    catalysts: [...accepted.values()],
    citations: citations.size,
    rejected: findings.length - accepted.size,
    searches: xSearchCalls(payload),
  }
}

/**
 * The shape asked of the model, written into the prompt rather than a response format.
 *
 * A strict `json_schema` response format suppresses server-side tool invocation on Grok,
 * so asking for this shape as structured output cost the search the whole request exists
 * to run. Nothing stated here is enforced by the provider either way: `FindingSchema`
 * re-validates every field and `CatalystSchema` validates again before anything reaches
 * D1. This text steers the model; the Zod parses are what actually bind the output.
 */
const OUTPUT_CONTRACT = 'Reply with one fenced ```json code block and no text after it. '
  + 'The block holds a single object {"findings": [...]} with at most 100 findings, and '
  + 'each finding is an object with exactly these fields: symbol (the ticker), kind (one '
  + 'of investor-event, product-event, regulatory, clinical, conference, shareholder), '
  + 'title (1-160 characters), description (1-500 characters), date (YYYY-MM-DD), timing '
  + '(one of pre-market, intraday, after-hours, unknown), confidence (confirmed or '
  + 'estimated), sourceUrl (a direct https://x.com/<handle>/status/<id> URL). Use '
  + '{"findings": []} when nothing qualifies. Any answer without that JSON block is discarded.'

export async function discoverXCatalysts(
  env: AppEnv,
  symbols: readonly string[],
  now = new Date(),
  fetcher: typeof fetch = fetch,
  gatewayRunId = crypto.randomUUID(),
  parentRunId?: string,
): Promise<XCatalystResult> {
  const watched = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].slice(0, MAX_SYMBOLS)
  if (!watched.length) return { catalysts: [], rejected: 0 }
  const [apiKey, gatewayToken, gatewayBaseUrl] = await Promise.all([
    readStoredSecret(env.XAI_API_KEY, 'XAI_API_KEY'),
    readStoredSecret(env.AI_GATEWAY_TOKEN, 'AI_GATEWAY_TOKEN'),
    grokGatewayBaseUrl(env),
  ])
  const today = marketDate(now)
  const searchFrom = addDays(today, -SEARCH_LOOKBACK_DAYS)
  const horizon = addDays(today, CATALYST_HORIZON_DAYS)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetcher(`${gatewayBaseUrl}/responses`, {
      method: 'POST', signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...aiGatewayHeaders(gatewayToken, {
          app: 'spice', feature: 'x-catalyst-research', market_date: today,
          parent_run_id: parentRunId ?? gatewayRunId, run_id: gatewayRunId,
        }),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        // The inline `[[N]](url)` citation markdown the Responses API adds by default
        // would land inside a finding's prose, and the findings now travel through a
        // fenced JSON block in ordinary output text where a marker breaks the document
        // outright. Suppressing it keeps the annotations that carry the trusted source
        // URLs; they simply stop carrying offsets into the prose.
        include: ['no_inline_citations'],
        input: [
          { role: 'system', content: `Find only material, scheduled, ticker-specific future catalysts announced in public X posts. Call the X search tool before answering; every finding must come from a post you actually retrieved, and an announcing post is normally much older than the event it announces. Do not include earnings or dividends. Never infer a date or claim that the cited post does not support. confirmed means a first-party company, executive, regulator, trial sponsor, exchange, or event organizer states an exact date; otherwise use estimated. Write a concise factual description of what is scheduled and why it may matter, using only the cited post. Copy each sourceUrl verbatim from the retrieved post; a URL you did not retrieve is discarded. Report no finding when evidence is weak. ${OUTPUT_CONTRACT}` },
          { role: 'user', content: `Search X for scheduled catalysts for only these tickers: ${watched.join(', ')}. Search each ticker. X search covers posts published from ${searchFrom} through ${today}; that is the publication window, not the event window. Keep an event only when it is scheduled from ${today} through ${horizon}, however long ago the post announcing it was written. Each sourceUrl must be the direct cited X status URL. Each description must be no more than 500 characters. Deduplicate equivalent events. Answer with the fenced json findings block and nothing after it.` },
        ],
        // Publication-date bounds; see SEARCH_LOOKBACK_DAYS. `to_date` is documented as
        // inclusive but observed to behave as the instant `to_date 00:00:00Z`, which
        // silently drops everything posted today, so it is carried one day past today.
        tools: [{ type: 'x_search', from_date: searchFrom, to_date: addDays(today, 1) }],
        // Grok decides for itself whether to search, and it repeatedly answered this
        // request in under half a minute without searching at all. `x_search` is the only
        // tool offered, so requiring a tool call can only mean searching X.
        //
        // No `text.format`: a strict json_schema response format suppresses server-side
        // tool invocation on Grok, and it outranked `tool_choice: 'required'` — the sweep
        // returned `x_search_calls: null` with zero citations in 20 seconds for 40
        // symbols, an answer from parametric memory. The findings shape is asked for in
        // the prompt instead and extracted from the fenced block in the answer.
        tool_choice: 'required',
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`XCatalystProvider:${response.status}`)
    }
    const result = parseXCatalystResponse(await readBoundedJson(response, MAX_RESPONSE_BYTES, 'XCatalystProvider'), watched, now)
    // Counts and an opaque run id only, never provider content. The run row cannot say
    // why a sweep accepted nothing; `searches` and `citations` are what tell the owner
    // whether the next barren run searched X and found nothing or never searched at all.
    console.info(JSON.stringify({
      event: 'XCatalystSearchCompleted',
      accepted: result.catalysts.length,
      citations: result.citations,
      rejected: result.rejected,
      runId: gatewayRunId,
      searches: result.searches ?? null,
      symbols: watched.length,
    }))
    return result
  } finally {
    clearTimeout(timeout)
  }
}

async function recordRun(env: AppEnv, values: {
  id: string; status: 'running' | 'completed' | 'failed'; symbols: number; startedAt: string;
  accepted?: number; rejected?: number; error?: string; completedAt?: string;
}): Promise<void> {
  if (!env.DB) return
  await env.DB.prepare(
    `INSERT INTO catalyst_research_runs
      (id, model, status, symbol_count, accepted_count, rejected_count, error_code, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, accepted_count = excluded.accepted_count,
      rejected_count = excluded.rejected_count, error_code = excluded.error_code, completed_at = excluded.completed_at`,
  ).bind(values.id, MODEL, values.status, values.symbols, values.accepted ?? null, values.rejected ?? null,
    values.error ?? null, values.startedAt, values.completedAt ?? null).run()
}

async function runXCatalystResearchForSymbols(
  env: AppEnv,
  symbols: readonly string[],
  now = new Date(),
  parentRunId?: string,
  persist = true,
): Promise<XCatalystResult> {
  const run = { id: crypto.randomUUID(), startedAt: now.toISOString(), symbols: symbols.length }
  if (persist) await recordRun(env, { ...run, status: 'running' })
  try {
    const result = await discoverXCatalysts(env, symbols, now, fetch, run.id, parentRunId)
    if (persist) {
      await persistResearchedCatalysts(env, 'x', result.catalysts, now)
      await recordRun(env, { ...run, status: 'completed', accepted: result.catalysts.length, rejected: result.rejected, completedAt: new Date().toISOString() })
    }
    return result
  } catch (error) {
    if (persist) await recordRun(env, { ...run, status: 'failed', error: error instanceof Error ? error.message.slice(0, 160) : 'UnknownError', completedAt: new Date().toISOString() })
    throw error
  }
}

const xCatalystResearchSeam = defineSeam(() => ({ runForSymbols: runXCatalystResearchForSymbols }))

export type XCatalystResearch = SeamValue<typeof xCatalystResearchSeam>

export const xCatalystResearch = xCatalystResearchSeam.current

export const setXCatalystResearch = xCatalystResearchSeam.set

export const resetXCatalystResearch = xCatalystResearchSeam.reset
