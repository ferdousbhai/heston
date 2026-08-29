import { type AppEnv } from './env'
import { rowsPerD1Statement } from './d1-limits'

const METRIC_BOUND_PARAMETERS_PER_ROW = 15
const QUOTE_BOUND_PARAMETERS_PER_ROW = 10
const METRIC_ROWS_PER_STATEMENT = rowsPerD1Statement(METRIC_BOUND_PARAMETERS_PER_ROW)
const QUOTE_ROWS_PER_STATEMENT = rowsPerD1Statement(QUOTE_BOUND_PARAMETERS_PER_ROW)

export type TastytradeMarketMetricRecord = {
  earningsDate: string | null
  historicalVolatility30Day?: number
  ivHistoricalVolatility30DayDifference?: number
  ivIndex: number
  ivIndex5DayChange?: number
  ivPercentile: number
  ivRank: number
  ivTermStructure?: {
    backExpiration: string
    backIv: number
    frontExpiration: string
    frontIv: number
  }
  liquidity: number
  marketCap?: number
  symbol: string
}

export type TastytradeMarketQuoteRecord = {
  change: number
  changePercent: number
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
        return [metric.symbol, metric.ivIndex, metric.ivRank, metric.ivPercentile,
        metric.ivIndex5DayChange ?? null, metric.historicalVolatility30Day ?? null,
        metric.ivHistoricalVolatility30DayDifference ?? null,
        term?.frontExpiration ?? null, term?.frontIv ?? null,
        term?.backExpiration ?? null, term?.backIv ?? null,
        metric.liquidity, metric.marketCap ?? null, metric.earningsDate, timestamp]
      })))
  }
  for (let start = 0; start < records.quotes.length; start += QUOTE_ROWS_PER_STATEMENT) {
    const chunk = records.quotes.slice(start, start + QUOTE_ROWS_PER_STATEMENT)
    statements.push(env.DB.prepare(
        `INSERT INTO tastytrade_market_quotes (
          symbol, price, previous_close, change_amount, change_percent, volume,
          year_low, year_high, provider_updated_at, observed_at
        ) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')}
        ON CONFLICT(symbol) DO UPDATE SET
          price = excluded.price,
          previous_close = excluded.previous_close,
          change_amount = excluded.change_amount,
          change_percent = excluded.change_percent,
          volume = excluded.volume,
          year_low = excluded.year_low,
          year_high = excluded.year_high,
          provider_updated_at = excluded.provider_updated_at,
          observed_at = excluded.observed_at`,
      ).bind(...chunk.flatMap((quote) => [
        quote.symbol, quote.price, quote.previousClose, quote.change, quote.changePercent,
        quote.volume ?? null, quote.yearLow ?? null, quote.yearHigh ?? null,
        quote.providerUpdatedAt, timestamp,
      ])))
  }
  await env.DB.batch(statements)
}
