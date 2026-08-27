import { type Ticker } from '../domain/market'
import { type AppEnv } from './env'

const METRIC_ROWS_PER_STATEMENT = 6
const QUOTE_ROWS_PER_STATEMENT = 10

/**
 * Persist normalized tastytrade responses into separate metric and quote source
 * tables. The UI Ticker is a read model only; neither table stores mixed facts.
 */
export async function persistTastytradeMarketSnapshot(
  env: AppEnv,
  tickers: readonly Ticker[],
  observedAt = new Date(),
): Promise<void> {
  if (!env.DB || !tickers.length) return
  const timestamp = observedAt.toISOString()
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < tickers.length; start += METRIC_ROWS_PER_STATEMENT) {
    const chunk = tickers.slice(start, start + METRIC_ROWS_PER_STATEMENT)
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
      ).bind(...chunk.flatMap((ticker) => {
        const term = ticker.ivTermStructure
        return [ticker.symbol, ticker.ivIndex, ticker.ivRank, ticker.ivPercentile,
        ticker.ivIndex5DayChange ?? null, ticker.historicalVolatility30Day ?? null,
        ticker.ivHistoricalVolatility30DayDifference ?? null,
        term?.frontExpiration ?? null, term?.frontIv ?? null,
        term?.backExpiration ?? null, term?.backIv ?? null,
        ticker.liquidity, ticker.marketCap ?? null, ticker.earningsDate, timestamp]
      })))
  }
  for (let start = 0; start < tickers.length; start += QUOTE_ROWS_PER_STATEMENT) {
    const chunk = tickers.slice(start, start + QUOTE_ROWS_PER_STATEMENT)
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
      ).bind(...chunk.flatMap((ticker) => [
        ticker.symbol, ticker.price, ticker.price - ticker.change, ticker.change, ticker.changePercent,
        ticker.volume ?? null, ticker.yearLow ?? null, ticker.yearHigh ?? null,
        ticker.updatedAt, timestamp,
      ])))
  }
  await env.DB.batch(statements)
}
