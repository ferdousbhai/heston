import { z } from 'zod'

import { CatalystSchema, marketDate, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { isValidIsoDate } from '../domain/iso-date'
import { type AppEnv } from './env'
import { jsonObject, jsonText, type JsonObject, type JsonValue } from '../domain/json-payload'
import { D1_MAX_BOUND_PARAMETERS, rowsPerD1Statement } from './d1-limits'

const TASTYTRADE_METRICS_URL = 'https://developer.tastytrade.com/open-api-spec/market-metrics/'
const DELETE_SYMBOL_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS
const CATALYST_BOUND_PARAMETERS_PER_ROW = 13
const CATALYST_ROWS_PER_STATEMENT = rowsPerD1Statement(CATALYST_BOUND_PARAMETERS_PER_ROW)

/**
 * Every producer writes the same row to the same table and is told apart by this column, so
 * adding one costs a value rather than a table, an upsert, and an arm on the view. A row's id
 * carries its producer too, which is what keeps it traceable to something that can refresh or
 * retract it — the property migration 0019 retired two tables for lacking.
 */
export type CatalystProvider = 'tastytrade' | 'daily-research' | 'dan' | 'exa'

function catalystUpsertStatements(
  db: D1Database,
  provider: CatalystProvider,
  catalysts: readonly Catalyst[],
  observedAt: string,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < catalysts.length; start += CATALYST_ROWS_PER_STATEMENT) {
    const chunk = catalysts.slice(start, start + CATALYST_ROWS_PER_STATEMENT)
    statements.push(db.prepare(
      `INSERT INTO catalysts
        (id, source_provider, symbol, kind, title, description, event_date, timing, confidence, source_label, source_url, updated_at, last_seen_at)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
       ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol, kind = excluded.kind, title = excluded.title,
        description = excluded.description, event_date = excluded.event_date,
        timing = excluded.timing, confidence = excluded.confidence,
        source_label = excluded.source_label, source_url = excluded.source_url,
        updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at`,
    ).bind(...chunk.flatMap((catalyst) => [
      catalyst.id, provider, catalyst.symbol, catalyst.kind, catalyst.title,
      catalyst.description ?? null, catalyst.date, catalyst.timing, catalyst.confidence,
      catalyst.source, catalyst.sourceUrl, catalyst.updatedAt, observedAt,
    ])))
  }
  return statements
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  const parsed = z.boolean().safeParse(value)
  if (!parsed.success) throw new Error(`TastytradeCatalyst:invalid-${key}`)
  return parsed.data
}

function earningsRecord(metric: JsonObject | undefined): JsonObject | undefined {
  const value = metric?.earnings
  if (value === undefined || value === null) return undefined
  const earnings = jsonObject(value)
  if (!earnings) throw new Error('TastytradeCatalyst:invalid-earnings')
  return earnings
}

function upcomingEarningsDate(earnings: JsonObject | undefined, today: string): string | undefined {
  if (!earnings || optionalBoolean(earnings, 'visible') === false) return undefined
  const rawDate = earnings['expected-report-date']
  if (rawDate === undefined || rawDate === null) return undefined
  const candidate = jsonText(rawDate)
  if (!candidate || !isValidIsoDate(candidate)) throw new Error('TastytradeCatalyst:invalid-earnings-date')
  if (candidate < today) return undefined
  return candidate
}

function providerTimestamp(value: JsonValue): string {
  const candidate = jsonText(value)
  if (!candidate || Number.isNaN(Date.parse(candidate))) {
    throw new Error('TastytradeCatalyst:invalid-updated-at')
  }
  return new Date(candidate).toISOString()
}

function earningsTiming(value: JsonValue): Catalyst['timing'] {
  if (value === undefined || value === null) return 'unknown'
  const parsed = z.string().safeParse(value)
  if (!parsed.success) throw new Error('TastytradeCatalyst:invalid-time-of-day')
  const timing = parsed.data.toLowerCase()
  if (timing.includes('before') || timing.includes('pre')) return 'pre-market'
  if (timing.includes('after') || timing.includes('post')) return 'after-hours'
  if (timing.includes('during') || timing.includes('market')) return 'intraday'
  return 'unknown'
}

export function catalystsFromMarketMetrics(metrics: readonly JsonObject[], now = new Date()): Catalyst[] {
  const today = marketDate(now)
  return metrics.flatMap((metric) => {
    const symbol = EquitySymbolSchema.parse(jsonText(metric.symbol)?.toUpperCase())
    const earnings = earningsRecord(metric)
    if (!earnings) return []
    const earningsDate = upcomingEarningsDate(earnings, today)
    if (!earningsDate) return []
    const estimated = optionalBoolean(earnings, 'estimated')
    const updatedAt = earnings['updated-at'] === undefined || earnings['updated-at'] === null
      ? providerTimestamp(metric['updated-at'])
      : providerTimestamp(earnings['updated-at'])
    return [CatalystSchema.parse({
      id: `tastytrade:${symbol}:earnings`,
      symbol,
      kind: 'earnings',
      title: `${symbol} earnings`,
      date: earningsDate,
      timing: earningsTiming(earnings['time-of-day']),
      confidence: estimated === false ? 'confirmed' : 'estimated',
      source: 'tastytrade market metrics',
      sourceUrl: TASTYTRADE_METRICS_URL,
      updatedAt,
    })]
  })
}

export function earningsDateFromMetric(metric: JsonObject | undefined, now = new Date()): string | null {
  const earnings = earningsRecord(metric)
  return upcomingEarningsDate(earnings, marketDate(now)) ?? null
}

export async function persistAndLoadCatalysts(
  env: AppEnv,
  observed: readonly Catalyst[],
  refreshedSymbols: readonly string[],
  now = new Date(),
): Promise<Catalyst[]> {
  if (!env.DB) throw new Error('CatalystStoreUnavailable')
  const normalizedSymbols = [...new Set(refreshedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < normalizedSymbols.length; start += DELETE_SYMBOL_CHUNK_SIZE) {
    const symbols = normalizedSymbols.slice(start, start + DELETE_SYMBOL_CHUNK_SIZE)
    statements.push(env.DB.prepare(
      `DELETE FROM catalysts
       WHERE source_provider = 'tastytrade' AND symbol IN (${symbols.map(() => '?').join(', ')})`,
    ).bind(...symbols))
  }
  statements.push(...catalystUpsertStatements(env.DB, 'tastytrade', observed, now.toISOString()))
  if (statements.length) await env.DB.batch(statements)
  const result = await env.DB.prepare(
    `SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
      source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"
     FROM upcoming_catalysts
     WHERE event_date >= ?
     ORDER BY event_date ASC, symbol ASC`,
  ).bind(marketDate(now)).all()
  return CatalystSchema.array().parse(result.results ?? [])
}

/**
 * Research sources are additive: unlike a fresh tastytrade earnings snapshot, one
 * source going quiet is not proof that a previously observed event was cancelled.
 * Keep each source's stable row and only refresh it when that source sees it again.
 */
export async function persistResearchCatalysts(
  env: AppEnv,
  provider: CatalystProvider,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Promise<void> {
  if (!env.DB) throw new Error('CatalystStoreUnavailable')
  if (!catalysts.length) return
  await env.DB.batch(catalystUpsertStatements(env.DB, provider, catalysts, now.toISOString()))
}
