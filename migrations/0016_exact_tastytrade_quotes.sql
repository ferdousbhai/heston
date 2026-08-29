-- The market-data contract reports price and previous close, not precomputed
-- daily-change fields. Keep the provider table exact and derive the move in the
-- display view/read model.
DROP VIEW public_market_overview;

ALTER TABLE tastytrade_market_quotes DROP COLUMN change_amount;
ALTER TABLE tastytrade_market_quotes DROP COLUMN change_percent;

CREATE VIEW public_market_overview AS
SELECT
  c.symbol,
  coalesce(c.description, c.short_description, c.symbol) AS instrument_name,
  c.is_etf,
  c.is_index,
  m.iv_index_percent,
  m.iv_rank_percent,
  m.iv_percentile_percent,
  m.iv_index_5_day_change_points,
  m.historical_volatility_30_day_percent,
  m.iv_hv_30_day_difference_points,
  m.front_expiration,
  m.front_iv_percent,
  m.back_expiration,
  m.back_iv_percent,
  m.liquidity_rating,
  m.market_cap,
  m.earnings_date,
  m.observed_at AS metrics_observed_at,
  q.price,
  q.previous_close,
  q.price - q.previous_close AS change_amount,
  ((q.price - q.previous_close) / q.previous_close) * 100 AS change_percent,
  q.volume,
  q.year_low,
  q.year_high,
  q.provider_updated_at AS quote_updated_at,
  q.observed_at AS quote_observed_at
FROM public_market_universe u
JOIN json_each(u.payload_json, '$.symbols') universe
JOIN instrument_catalog c ON c.symbol = universe.value
LEFT JOIN tastytrade_market_metrics m ON m.symbol = c.symbol
LEFT JOIN tastytrade_market_quotes q ON q.symbol = c.symbol
WHERE u.id = 'primary';
