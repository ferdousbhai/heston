-- The market-metrics OpenAPI defines these readings as optional numbers. Store
-- absent observations as NULL and keep reported values without local ranges.
-- No runtime path reads the legacy mixed-source view, so remove it here.
DROP VIEW public_market_overview;

CREATE TABLE tastytrade_market_metrics_optional (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  iv_index_percent REAL,
  iv_rank_percent REAL,
  iv_percentile_percent REAL,
  iv_index_5_day_change_points REAL,
  historical_volatility_30_day_percent REAL CHECK (
    historical_volatility_30_day_percent IS NULL OR historical_volatility_30_day_percent >= 0
  ),
  iv_hv_30_day_difference_points REAL,
  front_expiration TEXT,
  front_iv_percent REAL CHECK (front_iv_percent IS NULL OR front_iv_percent >= 0),
  back_expiration TEXT,
  back_iv_percent REAL CHECK (back_iv_percent IS NULL OR back_iv_percent >= 0),
  liquidity_rating REAL,
  market_cap REAL CHECK (market_cap IS NULL OR market_cap >= 0),
  earnings_date TEXT,
  observed_at TEXT NOT NULL
);

INSERT INTO tastytrade_market_metrics_optional
SELECT * FROM tastytrade_market_metrics;

DROP TABLE tastytrade_market_metrics;
ALTER TABLE tastytrade_market_metrics_optional RENAME TO tastytrade_market_metrics;

CREATE INDEX tastytrade_market_metrics_observed
  ON tastytrade_market_metrics(observed_at DESC, symbol ASC);
