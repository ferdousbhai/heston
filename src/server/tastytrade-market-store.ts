import { z } from 'zod'

import { MarketStateSchema, type MarketSnapshot } from '../domain/market'
import { type AppEnv } from './env'
import { rowsPerD1Statement } from './d1-limits'

const METRIC_BOUND_PARAMETERS_PER_ROW = 15
const QUOTE_BOUND_PARAMETERS_PER_ROW = 8
const METRIC_ROWS_PER_STATEMENT = rowsPerD1Statement(METRIC_BOUND_PARAMETERS_PER_ROW)
const QUOTE_ROWS_PER_STATEMENT = rowsPerD1Statement(QUOTE_BOUND_PARAMETERS_PER_ROW)

export type TastytradeMarketMetricRecord = {
  earningsDate: string | null
  historicalVolatility30Day?: number
  ivHistoricalVolatility30DayDifference?: number
  ivIndex?: number
  ivIndex5DayChange?: number
  ivPercentile?: number
  ivRank?: number
  ivTermStructure?: {
    backExpiration: string
    backIv: number
    frontExpiration: string
    frontIv: number
  }
  liquidity?: number
  marketCap?: number
  symbol: string
}

export type TastytradeMarketQuoteRecord = {
  previousClose: number
  price: number
  providerUpdatedAt: string
  symbol: string
  volume?: number
  yearHigh?: number
  yearLow?: number
}

export type TastytradeMarketRecords = {
  metrics: readonly TastytradeMarketMetricRecord[]
  quotes: readonly TastytradeMarketQuoteRecord[]
}

/**
 * Persist normalized tastytrade responses into separate metric and quote source
 * tables. The UI Ticker is a read model only; neither table stores mixed facts.
 */
export async function persistTastytradeMarketSnapshot(
  env: AppEnv,
  records: TastytradeMarketRecords,
  observedAt = new Date(),
): Promise<void> {
  if (!env.DB) throw new Error('TastytradeMarketStore:unavailable')
  if (!records.metrics.length && !records.quotes.length) return
  const timestamp = observedAt.toISOString()
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < records.metrics.length; start += METRIC_ROWS_PER_STATEMENT) {
    const chunk = records.metrics.slice(start, start + METRIC_ROWS_PER_STATEMENT)
    statements.push(env.DB.prepare(
        `INSERT INTO tastytrade_market_metrics (
          symbol, iv_index_percent, iv_rank_percent, iv_percentile_percent,
          iv_index_5_day_change_points, historical_volatility_30_day_percent,
          iv_hv_30_day_difference_points, front_expiration, front_iv_percent,
          back_expiration, back_iv_percent, liquidity_rating, market_cap,
          earnings_date, observed_at
        ) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        ON CONFLICT(symbol) DO UPDATE SET
          iv_index_percent = excluded.iv_index_percent,
          iv_rank_percent = excluded.iv_rank_percent,
          iv_percentile_percent = excluded.iv_percentile_percent,
          iv_index_5_day_change_points = excluded.iv_index_5_day_change_points,
          historical_volatility_30_day_percent = excluded.historical_volatility_30_day_percent,
          iv_hv_30_day_difference_points = excluded.iv_hv_30_day_difference_points,
          front_expiration = excluded.front_expiration,
          front_iv_percent = excluded.front_iv_percent,
          back_expiration = excluded.back_expiration,
          back_iv_percent = excluded.back_iv_percent,
          liquidity_rating = excluded.liquidity_rating,
          market_cap = excluded.market_cap,
          earnings_date = excluded.earnings_date,
          observed_at = excluded.observed_at`,
      ).bind(...chunk.flatMap((metric) => {
        const term = metric.ivTermStructure
        return [metric.symbol, metric.ivIndex ?? null, metric.ivRank ?? null, metric.ivPercentile ?? null,
        metric.ivIndex5DayChange ?? null, metric.historicalVolatility30Day ?? null,
        metric.ivHistoricalVolatility30DayDifference ?? null,
        term?.frontExpiration ?? null, term?.frontIv ?? null,
        term?.backExpiration ?? null, term?.backIv ?? null,
        metric.liquidity ?? null, metric.marketCap ?? null, metric.earningsDate, timestamp]
      })))
  }
  for (let start = 0; start < records.quotes.length; start += QUOTE_ROWS_PER_STATEMENT) {
    const chunk = records.quotes.slice(start, start + QUOTE_ROWS_PER_STATEMENT)
    statements.push(env.DB.prepare(
        `INSERT INTO tastytrade_market_quotes (
          symbol, price, previous_close, volume, year_low, year_high,
          provider_updated_at, observed_at
        ) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        ON CONFLICT(symbol) DO UPDATE SET
          price = excluded.price,
          previous_close = excluded.previous_close,
          volume = excluded.volume,
          year_low = excluded.year_low,
          year_high = excluded.year_high,
          provider_updated_at = excluded.provider_updated_at,
          observed_at = excluded.observed_at`,
      ).bind(...chunk.flatMap((quote) => [
        quote.symbol, quote.price, quote.previousClose, quote.volume ?? null,
        quote.yearLow ?? null, quote.yearHigh ?? null, quote.providerUpdatedAt, timestamp,
      ])))
  }
  await env.DB.batch(statements)
}

const StoredMetricRowSchema = z.object({
  symbol: z.string(),
  iv_index_percent: z.number().nullable(),
  iv_rank_percent: z.number().nullable(),
  iv_percentile_percent: z.number().nullable(),
  iv_index_5_day_change_points: z.number().nullable(),
  historical_volatility_30_day_percent: z.number().nullable(),
  iv_hv_30_day_difference_points: z.number().nullable(),
  front_expiration: z.string().nullable(),
  front_iv_percent: z.number().nullable(),
  back_expiration: z.string().nullable(),
  back_iv_percent: z.number().nullable(),
  liquidity_rating: z.number().nullable(),
  market_cap: z.number().nullable(),
  earnings_date: z.string().nullable(),
  observed_at: z.string(),
})

const StoredQuoteRowSchema = z.object({
  symbol: z.string(),
  price: z.number(),
  previous_close: z.number(),
  volume: z.number().nullable(),
  year_low: z.number().nullable(),
  year_high: z.number().nullable(),
  provider_updated_at: z.string(),
  observed_at: z.string(),
})

const SQL_SYMBOL_CHUNK_SIZE = 90

function optional(value: number | null): number | undefined {
  return value === null ? undefined : value
}

function storedMetricRecord(row: z.infer<typeof StoredMetricRowSchema>): TastytradeMarketMetricRecord {
  const term = row.front_expiration !== null && row.front_iv_percent !== null
    && row.back_expiration !== null && row.back_iv_percent !== null
    ? {
      backExpiration: row.back_expiration,
      backIv: row.back_iv_percent,
      frontExpiration: row.front_expiration,
      frontIv: row.front_iv_percent,
    }
    : undefined
  return {
    earningsDate: row.earnings_date,
    historicalVolatility30Day: optional(row.historical_volatility_30_day_percent),
    ivHistoricalVolatility30DayDifference: optional(row.iv_hv_30_day_difference_points),
    ivIndex: optional(row.iv_index_percent),
    ivIndex5DayChange: optional(row.iv_index_5_day_change_points),
    ivPercentile: optional(row.iv_percentile_percent),
    ivRank: optional(row.iv_rank_percent),
    ivTermStructure: term,
    liquidity: optional(row.liquidity_rating),
    marketCap: optional(row.market_cap),
    symbol: row.symbol,
  }
}

export type StoredMarketRecords = {
  metrics: Map<string, TastytradeMarketMetricRecord>
  /** The oldest reading in the set, which is what bounds how stale the snapshot is. */
  observedAt?: string
  quotes: Map<string, TastytradeMarketQuoteRecord>
}

/**
 * Read back what `persistTastytradeMarketSnapshot` wrote. A row that no longer parses is
 * skipped rather than fatal: the caller decides whether the remaining coverage is enough,
 * and one poisoned row must not deny every visitor a snapshot.
 */
export async function readStoredMarketRecords(
  env: AppEnv,
  symbols: readonly string[],
): Promise<StoredMarketRecords> {
  if (!env.DB) throw new Error('TastytradeMarketStore:unavailable')
  const metrics = new Map<string, TastytradeMarketMetricRecord>()
  const quotes = new Map<string, TastytradeMarketQuoteRecord>()
  let observedAt: string | undefined
  const observe = (value: string): void => {
    if (observedAt === undefined || value < observedAt) observedAt = value
  }
  for (let start = 0; start < symbols.length; start += SQL_SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + SQL_SYMBOL_CHUNK_SIZE)
    if (!chunk.length) continue
    const placeholders = chunk.map(() => '?').join(', ')
    const [metricResult, quoteResult] = await Promise.all([
      env.DB.prepare(`SELECT * FROM tastytrade_market_metrics WHERE symbol IN (${placeholders})`)
        .bind(...chunk).all(),
      env.DB.prepare(`SELECT * FROM tastytrade_market_quotes WHERE symbol IN (${placeholders})`)
        .bind(...chunk).all(),
    ])
    for (const result of metricResult.results) {
      const row = StoredMetricRowSchema.safeParse(result)
      if (!row.success) continue
      metrics.set(row.data.symbol, storedMetricRecord(row.data))
      observe(row.data.observed_at)
    }
    for (const result of quoteResult.results) {
      const row = StoredQuoteRowSchema.safeParse(result)
      if (!row.success) continue
      quotes.set(row.data.symbol, {
        previousClose: row.data.previous_close,
        price: row.data.price,
        providerUpdatedAt: row.data.provider_updated_at,
        symbol: row.data.symbol,
        volume: optional(row.data.volume),
        yearHigh: optional(row.data.year_high),
        yearLow: optional(row.data.year_low),
      })
      observe(row.data.observed_at)
    }
  }
  return { metrics, observedAt, quotes }
}

/**
 * Claim the exclusive right to refresh, without queueing. D1 applies one statement atomically,
 * so exactly one caller sees a changed row and every other caller serves the stored copy instead
 * of piling a second fan-out onto the provider. The claim expires on its own, so a refresh that
 * dies partway through cannot wedge the lease shut.
 */
export async function claimMarketRefresh(
  env: AppEnv,
  leaseMs: number,
  now = new Date(),
  id = 'public-snapshot',
): Promise<boolean> {
  // The lease is an optimization, so it fails open. A store that cannot answer must not be
  // able to deny every visitor a snapshot: losing the claim means "serve what you have", and
  // with nothing stored that ends in a 502. The cost of guessing wrong is one extra provider
  // refresh; the cost of failing closed is the whole public page.
  if (!env.DB) return true
  const nowIso = now.toISOString()
  const claimedUntil = new Date(now.getTime() + leaseMs).toISOString()
  try {
    // Upsert rather than update, so a resource claimed for the first time needs no seeded row.
    // The guard on the conflict branch is what makes a held claim reject a second caller.
    const result = await env.DB.prepare(
      `INSERT INTO market_refresh_lease (id, expires_at) VALUES (?, ?)
       ON CONFLICT(id) DO UPDATE SET expires_at = excluded.expires_at
         WHERE market_refresh_lease.expires_at <= ?`,
    ).bind(id, claimedUntil, nowIso).run()
    return result.meta.changes === 1
  } catch (error) {
    console.error('MarketRefreshLeaseUnavailable', error instanceof Error ? error.message : 'UnknownError')
    return true
  }
}


const StoredSessionRowSchema = z.object({
  state: z.string(),
  observed_at: z.string(),
  opens_at: z.string().nullable().optional(),
})

export type StoredMarketSession = {
  observedAt: string
  opensAt?: string
  state: MarketSnapshot['marketState']
}

export async function readStoredMarketSession(env: AppEnv): Promise<StoredMarketSession | undefined> {
  if (!env.DB) return undefined
  const result = await env.DB.prepare(
    "SELECT state, observed_at, opens_at FROM market_session WHERE id = 'equities'",
  ).first()
  if (!result) return undefined
  const row = StoredSessionRowSchema.safeParse(result)
  if (!row.success) return undefined
  const state = MarketStateSchema.safeParse(row.data.state)
  if (!state.success) return undefined
  return {
    observedAt: row.data.observed_at,
    opensAt: row.data.opens_at ?? undefined,
    state: state.data,
  }
}

export async function persistMarketSession(
  env: AppEnv,
  state: MarketSnapshot['marketState'],
  opensAt: string | undefined,
  observedAt = new Date(),
): Promise<void> {
  if (!env.DB) return
  await env.DB.prepare(
    `INSERT INTO market_session (id, state, observed_at, opens_at) VALUES ('equities', ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       state = excluded.state,
       observed_at = excluded.observed_at,
       opens_at = excluded.opens_at`,
  ).bind(state, observedAt.toISOString(), opensAt ?? null).run()
}
