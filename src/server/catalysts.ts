import { CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { type AppEnv } from './env'
import { jsonObjectOrEmpty, jsonText, type JsonObject, type JsonValue } from '../domain/json-payload'

const TASTYTRADE_METRICS_URL = 'https://developer.tastytrade.com/open-api-spec/market-metrics/'
const D1_MAX_BOUND_PARAMETERS = 100
const DELETE_SYMBOL_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 1

function date(value: JsonValue): string | undefined {
  const candidate = jsonText(value)
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return undefined
  const [year, month, day] = candidate.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day
    ? candidate
    : undefined
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
    const rows: Catalyst[] = []
    const candidateEarningsDate = earnings.visible === false ? undefined : date(earnings['expected-report-date'])
    const earningsDate = candidateEarningsDate && candidateEarningsDate >= today ? candidateEarningsDate : undefined
    if (earningsDate) {
      rows.push(CatalystSchema.parse({
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
      }))
    }

    return rows
  })
}

export function earningsDateFromMetric(metric: JsonObject | undefined, now = new Date()): string | null {
  const earnings = jsonObjectOrEmpty(metric?.earnings)
  const candidate = earnings.visible === false ? undefined : date(earnings['expected-report-date'])
  return candidate && candidate >= marketDate(now) ? candidate : null
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
        `DELETE FROM catalysts
         WHERE source_name = ? AND symbol IN (${symbols.map(() => '?').join(', ')})`,
      ).bind('tastytrade market metrics', ...symbols))
    }
    statements.push(...observed.map((catalyst) => env.DB!.prepare(
        `INSERT INTO catalysts
          (id, symbol, kind, title, description, event_date, timing, confidence, source_name, source_url, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          symbol = excluded.symbol, kind = excluded.kind, title = excluded.title,
          description = excluded.description,
          event_date = excluded.event_date, timing = excluded.timing,
          confidence = excluded.confidence, source_name = excluded.source_name,
          source_url = excluded.source_url, updated_at = excluded.updated_at,
          last_seen_at = excluded.last_seen_at`,
      ).bind(
        catalyst.id, catalyst.symbol, catalyst.kind, catalyst.title, catalyst.description ?? null, catalyst.date,
        catalyst.timing, catalyst.confidence, catalyst.source, catalyst.sourceUrl,
        catalyst.updatedAt, now.toISOString(),
      )))
    if (statements.length) await env.DB.batch(statements)
    const result = await env.DB.prepare(
      `SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
        source_name AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"
       FROM catalysts
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
  catalysts: readonly Catalyst[],
  now = new Date(),
): Promise<void> {
  if (!env.DB || !catalysts.length) return
  await env.DB.batch(catalysts.map((catalyst) => env.DB!.prepare(
    `INSERT INTO catalysts
      (id, symbol, kind, title, description, event_date, timing, confidence, source_name, source_url, updated_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      symbol = excluded.symbol, kind = excluded.kind, title = excluded.title,
      description = excluded.description, event_date = excluded.event_date,
      timing = excluded.timing, confidence = excluded.confidence,
      source_name = excluded.source_name, source_url = excluded.source_url,
      updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
  ).bind(
    catalyst.id, catalyst.symbol, catalyst.kind, catalyst.title, catalyst.description ?? null,
    catalyst.date, catalyst.timing, catalyst.confidence, catalyst.source,
    catalyst.sourceUrl, catalyst.updatedAt, now.toISOString(),
  )))
}
