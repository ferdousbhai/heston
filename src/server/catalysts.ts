import { z } from 'zod'

import {
  CatalystSchema,
  marketDate,
  MAX_CATALYSTS_PER_SYMBOL,
  RecordedCatalystSchema,
  type Catalyst,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { isValidIsoDate } from '../domain/iso-date'
import { type AppEnv } from './env'
import { jsonObject, jsonText, type JsonObject, type JsonValue } from '../domain/json-payload'
import { D1_MAX_BOUND_PARAMETERS, rowsPerD1Statement } from './d1-limits'
import { CallerVisibleError } from './caller-visible-error'

const TASTYTRADE_METRICS_URL = 'https://developer.tastytrade.com/open-api-spec/market-metrics/'
const DELETE_SYMBOL_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS
const CATALYST_BOUND_PARAMETERS_PER_ROW = 13
const CATALYST_ROWS_PER_STATEMENT = rowsPerD1Statement(CATALYST_BOUND_PARAMETERS_PER_ROW)

/**
 * Every producer writes the same row to the same table and is told apart by this column, so
 * adding one costs a value rather than a table, an upsert, and an arm on the view. A row's id
 * carries its producer too, which is what keeps it traceable to something that can refresh or
 * retract it — the property migration 0019 retired two tables for lacking.
 *
 * Only the producers that write today. The table's CHECK still admits the retired `dan` and
 * `daily-research` values because their rows remain on the calendar and are read like any other;
 * nothing here writes under either again.
 */
export type CatalystProvider = 'tastytrade' | 'exa' | 'member-research'

export function catalystUpsertStatements(
  db: D1Database,
  provider: CatalystProvider,
  catalysts: readonly Catalyst[],
  observedAt: string,
): D1PreparedStatement[] {
  // Every producer writes through here, so this is the one place the write envelope is held.
  const rows = catalysts.map((catalyst) => RecordedCatalystSchema.parse(catalyst))
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < rows.length; start += CATALYST_ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + CATALYST_ROWS_PER_STATEMENT)
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
  if (!parsed.success) throw new CallerVisibleError(`TastytradeCatalyst:invalid-${key}`)
  return parsed.data
}

function earningsRecord(metric: JsonObject | undefined): JsonObject | undefined {
  const value = metric?.earnings
  if (value === undefined || value === null) return undefined
  const earnings = jsonObject(value)
  if (!earnings) throw new CallerVisibleError('TastytradeCatalyst:invalid-earnings')
  return earnings
}

function upcomingEarningsDate(earnings: JsonObject | undefined, today: string): string | undefined {
  if (!earnings || optionalBoolean(earnings, 'visible') === false) return undefined
  const rawDate = earnings['expected-report-date']
  if (rawDate === undefined || rawDate === null) return undefined
  const candidate = jsonText(rawDate)
  if (!candidate || !isValidIsoDate(candidate)) throw new CallerVisibleError('TastytradeCatalyst:invalid-earnings-date')
  if (candidate < today) return undefined
  return candidate
}

function providerTimestamp(value: JsonValue): string {
  const candidate = jsonText(value)
  if (!candidate || Number.isNaN(Date.parse(candidate))) {
    throw new CallerVisibleError('TastytradeCatalyst:invalid-updated-at')
  }
  return new Date(candidate).toISOString()
}

function earningsTiming(value: JsonValue): Catalyst['timing'] {
  if (value === undefined || value === null) return 'unknown'
  const parsed = z.string().safeParse(value)
  if (!parsed.success) throw new CallerVisibleError('TastytradeCatalyst:invalid-time-of-day')
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

/**
 * Every row its producer still reports, which is the source every reader selects from.
 *
 * Research rows are additive on purpose: a source going quiet is not proof that an event it
 * once observed was cancelled, so nothing is deleted when a run stops mentioning it. But a
 * producer that searched the same symbol again and wrote a row for the same kind of event has
 * not gone quiet — it answered that question a second time, and the earlier row that later
 * write did not refresh is a date the producer no longer reports. Left in, one producer's two
 * answers reach a reader as two events, which is the same duplicate a second producer makes
 * and the one `distinctCatalysts` cannot fold, because a moved date is not the same date.
 *
 * `last_seen_at` is stamped on every row a write touches, so "this producer looked again and
 * did not see this" is a fact the store already holds; migration 0020 kept the column for
 * exactly this and nothing had ever read it. Partitioned by kind, so a run that reported
 * earnings says nothing about a conference an earlier one found, and two events of one kind
 * written by one run share a stamp and both stand.
 *
 * Only for a producer that answers for the whole symbol, which is what a `catalyst_runs`
 * receipt records: a search buys coverage of one name, so its later answer supersedes its
 * earlier one. A producer with no receipt is not one voice — `member-research`, like the retired
 * `daily-research` rows still stored, is whichever member's agent wrote that row — so a second member recording
 * a date is not the first one looking again, and nothing there retires anything. A later
 * producer earns this by writing a receipt, not by being named here.
 *
 * Retired from the read and never deleted: the row stays answerable to the producer that wrote
 * it, and a producer that reports that date again refreshes it back into view.
 */
export const CURRENT_CATALYSTS =
  `(SELECT c.id, c.source_provider, c.symbol, c.kind, c.title, c.description, c.event_date,
        c.timing, c.confidence, c.source_label, c.source_url, c.updated_at
      FROM (
        SELECT *, max(last_seen_at) OVER (PARTITION BY source_provider, symbol, kind) AS latest_sighting
          FROM upcoming_catalysts
      ) c
     WHERE c.last_seen_at = c.latest_sighting
        OR NOT EXISTS (
          SELECT 1 FROM catalyst_runs r
           WHERE r.source_provider = c.source_provider AND r.symbol = c.symbol
        ))`

/*
 * Every producer's upcoming rows, nearest first, for at most `MAX_CATALYSTS_PER_SYMBOL` events
 * per symbol. The cap counts events, not rows: two producers that saw one event wrote two rows,
 * which `distinctCatalysts` folds into one for a reader, and a cap on rows spent a symbol's ten
 * on its duplicates and dropped real events off the far end. So the window ranks by the fold's
 * own event identity -- symbol, date and kind -- and every sighting of a kept event is returned
 * for the reader to fold. A dense rank gives each event one number however many rows share it,
 * and orders a symbol's events by date first, so the cap still drops only the far end.
 */
const EVENT_RANK = 'DENSE_RANK() OVER (PARTITION BY symbol ORDER BY event_date ASC, kind ASC)'

const UPCOMING_CATALYSTS_QUERY =
  `SELECT id, symbol, kind, title, description, date, timing, confidence, source, "sourceUrl", "updatedAt"
     FROM (
       SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
           source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt",
           ${EVENT_RANK} AS nearest
         FROM ${CURRENT_CATALYSTS}
         WHERE event_date >= ?
     )
     WHERE nearest <= ?
     ORDER BY date ASC, symbol ASC, id ASC`

/** The upcoming-catalyst read, for a caller that must not write. */
export async function readUpcomingCatalysts(env: AppEnv, now = new Date()): Promise<Catalyst[]> {
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  const result = await env.DB.prepare(UPCOMING_CATALYSTS_QUERY)
    .bind(marketDate(now), MAX_CATALYSTS_PER_SYMBOL).all()
  return CatalystSchema.array().parse(result.results ?? [])
}

/** One symbol's events under the same event-counted cap as the snapshot. */
const SYMBOL_CATALYSTS_QUERY =
  `SELECT id, symbol, kind, title, description, date, timing, confidence, source, "sourceUrl", "updatedAt"
     FROM (
       SELECT id, symbol, kind, title, description, event_date AS date, timing, confidence,
           source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt",
           ${EVENT_RANK} AS nearest
         FROM ${CURRENT_CATALYSTS}
         WHERE event_date >= ? AND symbol = ?
     )
     WHERE nearest <= ?
     ORDER BY date ASC, id ASC`

/** Full rows for one symbol, including description and source, for the focused runway. */
export async function readUpcomingCatalystsForSymbol(
  env: AppEnv,
  symbol: string,
  now = new Date(),
): Promise<Catalyst[]> {
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  const result = await env.DB.prepare(SYMBOL_CATALYSTS_QUERY)
    .bind(marketDate(now), EquitySymbolSchema.parse(symbol), MAX_CATALYSTS_PER_SYMBOL).all()
  return CatalystSchema.array().parse(result.results ?? [])
}

export async function persistAndLoadCatalysts(
  env: AppEnv,
  observed: readonly Catalyst[],
  refreshedSymbols: readonly string[],
  now = new Date(),
): Promise<Catalyst[]> {
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
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
  return readUpcomingCatalysts(env, now)
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
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  if (!catalysts.length) return
  await env.DB.batch(catalystUpsertStatements(env.DB, provider, catalysts, now.toISOString()))
}
