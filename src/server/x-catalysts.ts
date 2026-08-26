import { z } from 'zod'

import { aiGatewayHeaders, grokGatewayBaseUrl } from './ai-gateway'
import { CatalystKindSchema, CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import { type AppEnv } from './env'
import { readBoundedJson } from './bounded-response'
import { JsonArraySchema, jsonObjectOrEmpty, type JsonValue } from '../domain/json-payload'
import { readStoredSecret } from './secrets'
import { persistResearchedCatalysts } from './catalysts'

const MODEL = 'grok-4.6'
const SOURCE = 'Grok 4.6 X research'
const MAX_RESPONSE_BYTES = 2_000_000
const MAX_SYMBOLS = 40

export function catalystResearchSymbols(watchlists: readonly { kind: string; symbols: readonly string[] }[]): string[] {
  const positions = watchlists.filter((watchlist) => watchlist.kind === 'positions')
  const privateLists = watchlists.filter((watchlist) => watchlist.kind === 'private')
  return [...new Set([...positions, ...privateLists]
    .flatMap((watchlist) => watchlist.symbols.map((symbol) => symbol.toUpperCase())))]
    .slice(0, MAX_SYMBOLS)
}

const FindingSchema = z.object({
  symbol: z.string(),
  kind: CatalystKindSchema.exclude(['earnings']),
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(500),
  date: z.string(),
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  confidence: z.enum(['confirmed', 'estimated']),
  sourceUrl: z.string(),
})

const FindingsSchema = z.object({ findings: z.array(FindingSchema).max(100) })

/** Model output text is compared verbatim, so it is never trimmed on the way in. */
const ModelTextSchema = z.string()

export type XCatalystResult = { catalysts: Catalyst[]; rejected: number }

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function canonicalXPostUrl(value: JsonValue): string | undefined {
  const raw = ModelTextSchema.safeParse(value).data
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

function citationUrls(payload: JsonValue): Set<string> {
  const urls = new Set<string>()
  const body = jsonObjectOrEmpty(payload)
  for (const citation of JsonArraySchema.safeParse(body.citations).data ?? []) {
    const url = canonicalXPostUrl(ModelTextSchema.safeParse(citation).data ?? jsonObjectOrEmpty(citation).url)
    if (url) urls.add(url)
  }
  for (const output of (JsonArraySchema.safeParse(body.output).data ?? []).map(jsonObjectOrEmpty)) {
    for (const content of (JsonArraySchema.safeParse(output.content).data ?? []).map(jsonObjectOrEmpty)) {
      for (const annotation of (JsonArraySchema.safeParse(content.annotations).data ?? []).map(jsonObjectOrEmpty)) {
        const url = canonicalXPostUrl(annotation.url)
        if (url) urls.add(url)
      }
    }
  }
  return urls
}

function outputText(payload: JsonValue): string | undefined {
  for (const item of (JsonArraySchema.safeParse(jsonObjectOrEmpty(payload).output).data ?? []).map(jsonObjectOrEmpty)) {
    for (const content of (JsonArraySchema.safeParse(item.content).data ?? []).map(jsonObjectOrEmpty)) {
      const text = ModelTextSchema.safeParse(content.text).data
      if (content.type === 'output_text' && text !== undefined) return text
    }
  }
  return undefined
}

export function parseXCatalystResponse(
  payload: JsonValue,
  allowedSymbols: readonly string[],
  now = new Date(),
): XCatalystResult {
  const text = outputText(payload)
  if (!text) throw new Error('XCatalystResponse:missing-output')
  const findings = FindingsSchema.parse(JSON.parse(text)).findings
  const citations = citationUrls(payload)
  const symbols = new Set(allowedSymbols.map((symbol) => symbol.toUpperCase()))
  const today = marketDate(now)
  const horizon = addDays(today, 180)
  const accepted = new Map<string, Catalyst>()
  let rejected = 0
  for (const finding of findings) {
    const symbol = finding.symbol.toUpperCase()
    const sourceUrl = canonicalXPostUrl(finding.sourceUrl)
    if (!symbols.has(symbol) || !isValidIsoDate(finding.date) || finding.date < today || finding.date > horizon || !sourceUrl || !citations.has(sourceUrl)) {
      rejected++
      continue
    }
    const id = `xai-x-search:${symbol}:${finding.kind}:${finding.date}`
    const catalyst = CatalystSchema.parse({ ...finding, id, symbol, sourceUrl, source: SOURCE, updatedAt: now.toISOString() })
    const current = accepted.get(id)
    if (!current || (current.confidence === 'estimated' && catalyst.confidence === 'confirmed')) accepted.set(id, catalyst)
  }
  return { catalysts: [...accepted.values()], rejected: rejected + findings.length - rejected - accepted.size }
}

function responseSchema() {
  return {
    type: 'object', additionalProperties: false, required: ['findings'],
    properties: {
      findings: {
        type: 'array', maxItems: 100,
        items: {
          type: 'object', additionalProperties: false,
          required: ['symbol', 'kind', 'title', 'description', 'date', 'timing', 'confidence', 'sourceUrl'],
          properties: {
            symbol: { type: 'string' },
            kind: { type: 'string', enum: ['investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder'] },
            title: { type: 'string', minLength: 1, maxLength: 160 },
            description: { type: 'string', minLength: 1, maxLength: 500 },
            date: { type: 'string' },
            timing: { type: 'string', enum: ['pre-market', 'intraday', 'after-hours', 'unknown'] },
            confidence: { type: 'string', enum: ['confirmed', 'estimated'] },
            sourceUrl: { type: 'string' },
          },
        },
      },
    },
  }
}

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
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 5 * 60_000)
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
        input: [
          { role: 'system', content: 'Find only material, scheduled, ticker-specific future catalysts announced in public X posts. Do not include earnings or dividends. Never infer a date or claim that the cited post does not support. confirmed means a first-party company, executive, regulator, trial sponsor, exchange, or event organizer states an exact date; otherwise use estimated. Write a concise factual description of what is scheduled and why it may matter, using only the cited post. Return an empty array when evidence is weak.' },
          { role: 'user', content: `Search X for scheduled catalysts from ${today} through ${addDays(today, 180)} for only these tickers: ${watched.join(', ')}. Each sourceUrl must be the direct cited X status URL. Each description must be no more than 500 characters. Deduplicate equivalent events.` },
        ],
        tools: [{ type: 'x_search', from_date: addDays(today, -3), to_date: today }],
        text: { format: { type: 'json_schema', name: 'spice_upcoming_catalysts', strict: true, schema: responseSchema() } },
      }),
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new Error(`XCatalystProvider:${response.status}`)
    }
    return parseXCatalystResponse(await readBoundedJson(response, MAX_RESPONSE_BYTES, 'XCatalystProvider'), watched, now)
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
): Promise<XCatalystResult> {
  const run = { id: crypto.randomUUID(), startedAt: now.toISOString(), symbols: symbols.length }
  await recordRun(env, { ...run, status: 'running' })
  try {
    const result = await discoverXCatalysts(env, symbols, now, fetch, run.id, parentRunId)
    await persistResearchedCatalysts(env, 'x', result.catalysts, now)
    await recordRun(env, { ...run, status: 'completed', accepted: result.catalysts.length, rejected: result.rejected, completedAt: new Date().toISOString() })
    return result
  } catch (error) {
    await recordRun(env, { ...run, status: 'failed', error: error instanceof Error ? error.message.slice(0, 160) : 'UnknownError', completedAt: new Date().toISOString() })
    throw error
  }
}

function createXCatalystResearch() {
  return { runForSymbols: runXCatalystResearchForSymbols }
}

export type XCatalystResearch = ReturnType<typeof createXCatalystResearch>

let installedXCatalystResearch: XCatalystResearch = createXCatalystResearch()

export function xCatalystResearch(): XCatalystResearch {
  return installedXCatalystResearch
}

export function setXCatalystResearch(next: XCatalystResearch): void {
  installedXCatalystResearch = next
}

export function resetXCatalystResearch(): void {
  installedXCatalystResearch = createXCatalystResearch()
}
