import { z } from 'zod'

import { CatalystKindSchema, CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { type AppEnv, isLiveTastytrade } from './env'
import { readBoundedJson } from './bounded-response'
import { readSecret } from './secrets'
import { loadMarketSnapshot } from './tastytrade'

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
  date: z.string(),
  timing: z.enum(['pre-market', 'intraday', 'after-hours', 'unknown']),
  confidence: z.enum(['confirmed', 'estimated']),
  sourceUrl: z.string(),
})

const FindingsSchema = z.object({ findings: z.array(FindingSchema).max(100) })

type JsonRecord = Record<string, unknown>

function record(value: unknown): JsonRecord {
  return typeof value === 'object' && value !== null ? value as JsonRecord : {}
}

function isoDateIsValid(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
}

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10)
}

export function canonicalXPostUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || !['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())) return undefined
    if (!/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status\/\d+$/.test(url.pathname)) return undefined
    return `https://x.com${url.pathname}`
  } catch {
    return undefined
  }
}

function citationUrls(payload: unknown): Set<string> {
  const urls = new Set<string>()
  const body = record(payload)
  if (Array.isArray(body.citations)) {
    for (const citation of body.citations) {
      const url = canonicalXPostUrl(typeof citation === 'string' ? citation : record(citation).url)
      if (url) urls.add(url)
    }
  }
  if (Array.isArray(body.output)) {
    for (const output of body.output.map(record)) {
      if (!Array.isArray(output.content)) continue
      for (const content of output.content.map(record)) {
        if (!Array.isArray(content.annotations)) continue
        for (const annotation of content.annotations.map(record)) {
          const url = canonicalXPostUrl(annotation.url)
          if (url) urls.add(url)
        }
      }
    }
  }
  return urls
}

function outputText(payload: unknown): string | undefined {
  const output = record(payload).output
  if (!Array.isArray(output)) return undefined
  for (const item of output.map(record)) {
    if (!Array.isArray(item.content)) continue
    for (const content of item.content.map(record)) {
      if (content.type === 'output_text' && typeof content.text === 'string') return content.text
    }
  }
  return undefined
}

export function parseXCatalystResponse(
  payload: unknown,
  allowedSymbols: readonly string[],
  now = new Date(),
): { catalysts: Catalyst[]; rejected: number } {
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
    if (!symbols.has(symbol) || !isoDateIsValid(finding.date) || finding.date < today || finding.date > horizon || !sourceUrl || !citations.has(sourceUrl)) {
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
          required: ['symbol', 'kind', 'title', 'date', 'timing', 'confidence', 'sourceUrl'],
          properties: {
            symbol: { type: 'string' },
            kind: { type: 'string', enum: ['investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder'] },
            title: { type: 'string' }, date: { type: 'string' },
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
): Promise<{ catalysts: Catalyst[]; rejected: number }> {
  const watched = [...new Set(symbols.map((symbol) => symbol.toUpperCase()))].slice(0, MAX_SYMBOLS)
  if (!watched.length) return { catalysts: [], rejected: 0 }
  const [apiKey, gatewayToken] = await Promise.all([
    readSecret(env.XAI_API_KEY, 'XAI_API_KEY'),
    readSecret(env.AI_GATEWAY_TOKEN, 'AI_GATEWAY_TOKEN'),
  ])
  const today = marketDate(now)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 55_000)
  try {
    const response = await fetcher('https://gateway.ai.cloudflare.com/v1/0af9e0921b880657d84a6c07307f8aef/ask-dan/grok/v1/responses', {
      method: 'POST', signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'cf-aig-authorization': `Bearer ${gatewayToken}`,
        'cf-aig-collect-log': 'false', 'cf-aig-collect-log-payload': 'false',
        'cf-aig-skip-cache': 'true', 'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: [
          { role: 'system', content: 'Find only material, scheduled, ticker-specific future catalysts announced in public X posts. Do not include earnings or dividends. Never infer a date that the cited post does not support. confirmed means a first-party company, executive, regulator, trial sponsor, exchange, or event organizer states an exact date; otherwise use estimated. Return an empty array when evidence is weak.' },
          { role: 'user', content: `Search X for scheduled catalysts from ${today} through ${addDays(today, 180)} for only these tickers: ${watched.join(', ')}. Each sourceUrl must be the direct cited X status URL. Deduplicate equivalent events.` },
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

async function persist(env: AppEnv, catalysts: readonly Catalyst[], now: Date): Promise<void> {
  if (!env.DB || !catalysts.length) return
  await env.DB.batch(catalysts.map((catalyst) => env.DB!.prepare(
    `INSERT INTO catalysts
      (id, symbol, kind, title, event_date, timing, confidence, source_name, source_url, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title, timing = excluded.timing,
      confidence = excluded.confidence, source_url = excluded.source_url,
      updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
  ).bind(catalyst.id, catalyst.symbol, catalyst.kind, catalyst.title, catalyst.date, catalyst.timing,
    catalyst.confidence, catalyst.source, catalyst.sourceUrl, catalyst.updatedAt, now.toISOString())))
}

export function shouldRunXCatalystResearch(date: Date): boolean {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).map((part) => [part.type, part.value]))
  return parts.weekday !== 'Sat' && parts.weekday !== 'Sun' && parts.hour === '18' && parts.minute === '30'
}

export async function runXCatalystResearch(env: AppEnv, now = new Date()): Promise<{ accepted: number; rejected: number }> {
  if (!isLiveTastytrade(env)) throw new Error('XCatalystResearch:live-mode-required')
  const snapshot = await loadMarketSnapshot(env)
  const symbols = catalystResearchSymbols(snapshot.watchlists)
  const run = { id: crypto.randomUUID(), startedAt: now.toISOString(), symbols: symbols.length }
  await recordRun(env, { ...run, status: 'running' })
  try {
    const result = await discoverXCatalysts(env, symbols, now)
    await persist(env, result.catalysts, now)
    await recordRun(env, { ...run, status: 'completed', accepted: result.catalysts.length, rejected: result.rejected, completedAt: new Date().toISOString() })
    return { accepted: result.catalysts.length, rejected: result.rejected }
  } catch (error) {
    await recordRun(env, { ...run, status: 'failed', error: error instanceof Error ? error.message.slice(0, 160) : 'UnknownError', completedAt: new Date().toISOString() })
    throw error
  }
}
