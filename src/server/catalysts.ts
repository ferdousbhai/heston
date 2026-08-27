import { CatalystSchema, isValidIsoDate, marketDate, type Catalyst } from '../domain/catalyst'
import { type AppEnv } from './env'
import { jsonObjectOrEmpty, jsonText, type JsonObject, type JsonValue } from '../domain/json-payload'

const TASTYTRADE_METRICS_URL = 'https://developer.tastytrade.com/open-api-spec/market-metrics/'
const D1_MAX_BOUND_PARAMETERS = 100
const DELETE_SYMBOL_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS
const CATALYST_ROWS_PER_STATEMENT = 8

export type ResearchCatalystSource = 'codex-web' | 'reddit' | 'x'

const RESEARCH_CATALYST_TABLES = {
  'codex-web': 'codex_web_catalysts',
  reddit: 'reddit_catalysts',
  x: 'x_catalysts',
} as const satisfies Record<ResearchCatalystSource, string>

type CatalystTable = 'tastytrade_catalysts' | (typeof RESEARCH_CATALYST_TABLES)[ResearchCatalystSource]

function catalystUpsertStatements(
  db: D1Database,
  table: CatalystTable,
  catalysts: readonly Catalyst[],
  observedAt: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < catalysts.length; start += CATALYST_ROWS_PER_STATEMENT) {
    const chunk = catalysts.slice(start, start + CATALYST_ROWS_PER_STATEMENT)
    statements.push(db.prepare(
      `INSERT INTO ${table}
        (id, symbol, kind, title, description, event_date, timing, confidence, source_label, source_url, updated_at, last_seen_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol, kind = excluded.kind, title = excluded.title,
        description = excluded.description, event_date = excluded.event_date,
        timing = excluded.timing, confidence = excluded.confidence,
        source_label = excluded.source_label, source_url = excluded.source_url,
        updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
    ).bind(...chunk.flatMap((catalyst) => [
      catalyst.id, catalyst.symbol, catalyst.kind, catalyst.title, catalyst.description ?? null,
      catalyst.date, catalyst.timing, catalyst.confidence, catalyst.source,
      catalyst.sourceUrl, catalyst.updatedAt, observedAt,
    ])))
  }
  return statements
}

/** An upcoming, visible tastytrade earnings date, or undefined. */
function upcomingEarningsDate(earnings: JsonObject, today: string): string | undefined {
  if (earnings.visible === false) return undefined
  const candidate = jsonText(earnings['expected-report-date'])
  if (!candidate || !isValidIsoDate(candidate) || candidate < today) return undefined
  return candidate
}

function iso(value: JsonValue, fallback: string): string {
  const candidate = jsonText(value)
  return candidate && !Number.isNaN(Date.parse(candidate)) ? new Date(candidate).toISOString() : fallback
}

function earningsTiming(value: JsonValue): Catalyst['timing'] {
  const timing = jsonText(value)?.toLowerCase() ?? ''
  if (timing.includes('before') || timing.includes('pre')) return 'pre-market'
  if (timing.includes('after') || timing.includes('post')) return 'after-hours'
  if (timing.includes('during') || timing.includes('market')) return 'intraday'
  return 'unknown'
}

/** Normalize only upcoming earnings returned by tastytrade market metrics. */
export function catalystsFromMarketMetrics(metrics: readonly JsonObject[], now = new Date()): Catalyst[] {
  const observedAt = now.toISOString()
  const today = marketDate(now)
  return metrics.flatMap((metric) => {
    const symbol = jsonText(metric.symbol)?.toUpperCase()
    if (!symbol) return []
    const earnings = jsonObjectOrEmpty(metric.earnings)
    const earningsDate = upcomingEarningsDate(earnings, today)
    if (!earningsDate) return []
    return [CatalystSchema.parse({
      id: `tastytrade:${symbol}:earnings`,
      symbol,
      kind: 'earnings',
      title: `${symbol} earnings`,
      date: earningsDate,
      timing: earningsTiming(earnings['time-of-day']),
      confidence: earnings.estimated === false ? 'confirmed' : 'estimated',
      source: 'tastytrade market metrics',
      sourceUrl: TASTYTRADE_METRICS_URL,
      updatedAt: iso(earnings['updated-at'] ?? metric['updated-at'], observedAt),
    })]
  })
}

export function earningsDateFromMetric(metric: JsonObject | undefined, now = new Date()): string | null {
  const earnings = jsonObjectOrEmpty(metric?.earnings)
  return upcomingEarningsDate(earnings, marketDate(now)) ?? null
}

export async function persistAndLoadCatalysts(
  env: AppEnv,
  observed: readonly Catalyst[],
  refreshedSymbols: readonly string[],
  now = new Date(),
): Promise<Catalyst[]> {
  if (!env.DB) return [...observed]
  try {
    const normalizedSymbols = [...new Set(refreshedSymbols.map((symbol) => symbol.toUpperCase()))]
    const statements: D1PreparedStatement[] = []
    for (let start = 0; start < normalizedSymbols.length; start += DELETE_SYMBOL_CHUNK_SIZE) {
      const symbols = normalizedSymbols.slice(start, start + DELETE_SYMBOL_CHUNK_SIZE)
      statements.push(env.DB.prepare(
        `DELETE FROM tastytrade_catalysts
         WHERE symbol IN (${symbols.map(() => '?').join(', ')})`,
      ).bind(...symbols))
    }
    statements.push(...catalystUpsertStatements(env.DB, 'tastytrade_catalysts', observed, now.toISOString()))
    if (statements.length) await env.DB.batch(statements)
    const result = await env.DB.prepare(
      `SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
        source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"
       FROM upcoming_catalysts
       WHERE event_date >= ?
       ORDER BY event_date ASC, symbol ASC`,
    ).bind(marketDate(now)).all()
    return CatalystSchema.array().parse(result.results ?? [])
  } catch (error) {
    console.error('CatalystStoreFailed', error instanceof Error ? error.message : 'UnknownError')
    return [...observed]
  }
}

/**
 * Research sources are additive: unlike a fresh tastytrade earnings snapshot, one
 * source going quiet is not proof that a previously observed event was cancelled.
 * Keep each source's stable row and only refresh it when that source sees it again.
 */
export async function persistResearchedCatalysts(
  env: AppEnv,
  source: ResearchCatalystSource,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Promise<void> {
  if (!env.DB || !catalysts.length) return
  const table = RESEARCH_CATALYST_TABLES[source]
  await env.DB.batch(catalystUpsertStatements(env.DB, table, catalysts, now.toISOString()))
}
