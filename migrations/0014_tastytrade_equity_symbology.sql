-- Every stored symbol now follows tastytrade's own equity symbology: "Equity symbols
-- contain only alphanumeric characters (A-Z, 0-9) with an occasional `/`. A few examples:
-- AAPL BRK/A" (https://developer.tastytrade.com/api-overview/#tastytrade-symbology).
--
-- The previous constraint admitted the NASDAQ dot rendering and rejected both digits and
-- the slash, so a class share the broker returns as BRK/B could not be stored at all and a
-- catalog refresh that received one failed the whole batch. The dot form is not tastytrade's
-- and the broker 404s on it, so existing dotted rows are carried over in broker notation.
--
-- SQLite cannot alter a CHECK, so each constrained table is rebuilt forward-only. These GLOB
-- checks bound the character set, the slash position, and the length; `EquitySymbolSchema`
-- stays the exact rule and the only place the root and class widths are expressed.

DROP VIEW public_market_overview;

-- Maintained live watchlist rows.
DROP INDEX internal_watchlist_items_updated;
ALTER TABLE internal_watchlist_items RENAME TO internal_watchlist_items_pre_symbology;

CREATE TABLE internal_watchlist_items (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  instrument_type TEXT NOT NULL CHECK (instrument_type = 'Equity'),
  origin TEXT NOT NULL CHECK (origin IN (
    'tastytrade-seed', 'scheduled-research', 'agent-discussion',
    'position-sync', 'trade-intent', 'owner'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO internal_watchlist_items
SELECT replace(symbol, '.', '/'), instrument_type, origin, metadata_json, created_at, updated_at
FROM internal_watchlist_items_pre_symbology;

DROP TABLE internal_watchlist_items_pre_symbology;

CREATE INDEX internal_watchlist_items_updated
  ON internal_watchlist_items(updated_at DESC);

-- Typed tastytrade Equity projection and its ordered tick tiers. The child is renamed first
-- so that renaming the parent retargets its foreign key at the retiring table, never the new one.
DROP INDEX instrument_catalog_status_refresh;
ALTER TABLE instrument_tick_sizes RENAME TO instrument_tick_sizes_pre_symbology;
ALTER TABLE instrument_catalog RENAME TO instrument_catalog_pre_symbology;

CREATE TABLE instrument_catalog (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  source_name TEXT NOT NULL DEFAULT 'tastytrade' CHECK (source_name = 'tastytrade'),
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 512),
  short_description TEXT CHECK (short_description IS NULL OR length(short_description) BETWEEN 1 AND 256),
  instrument_type TEXT NOT NULL CHECK (instrument_type = 'Equity'),
  instrument_sub_type TEXT CHECK (instrument_sub_type IS NULL OR length(instrument_sub_type) <= 128),
  streamer_symbol TEXT CHECK (streamer_symbol IS NULL OR length(streamer_symbol) <= 128),
  listed_market TEXT CHECK (listed_market IS NULL OR length(listed_market) <= 128),
  market_time_instrument_collection TEXT CHECK (
    market_time_instrument_collection IS NULL OR length(market_time_instrument_collection) <= 128
  ),
  country_of_incorporation TEXT CHECK (country_of_incorporation IS NULL OR length(country_of_incorporation) <= 128),
  country_of_taxation TEXT CHECK (country_of_taxation IS NULL OR length(country_of_taxation) <= 128),
  underlying_product_type TEXT CHECK (underlying_product_type IS NULL OR length(underlying_product_type) <= 128),
  is_etf INTEGER CHECK (is_etf IS NULL OR is_etf IN (0, 1)),
  is_index INTEGER CHECK (is_index IS NULL OR is_index IN (0, 1)),
  pre_ipo INTEGER CHECK (pre_ipo IS NULL OR pre_ipo IN (0, 1)),
  active INTEGER CHECK (active IS NULL OR active IN (0, 1)),
  is_closing_only INTEGER CHECK (is_closing_only IS NULL OR is_closing_only IN (0, 1)),
  is_options_closing_only INTEGER CHECK (is_options_closing_only IS NULL OR is_options_closing_only IN (0, 1)),
  is_illiquid INTEGER CHECK (is_illiquid IS NULL OR is_illiquid IN (0, 1)),
  is_fractional_quantity_eligible INTEGER CHECK (
    is_fractional_quantity_eligible IS NULL OR is_fractional_quantity_eligible IN (0, 1)
  ),
  overnight_trading_permitted INTEGER CHECK (
    overnight_trading_permitted IS NULL OR overnight_trading_permitted IN (0, 1)
  ),
  bypass_manual_review INTEGER CHECK (bypass_manual_review IS NULL OR bypass_manual_review IN (0, 1)),
  halted_at TEXT CHECK (halted_at IS NULL OR length(halted_at) <= 64),
  stops_trading_at TEXT CHECK (stops_trading_at IS NULL OR length(stops_trading_at) <= 64),
  lendability TEXT CHECK (lendability IS NULL OR length(lendability) <= 128),
  borrow_rate REAL,
  identity_refreshed_at TEXT NOT NULL,
  status_refreshed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  resolution_status TEXT NOT NULL DEFAULT 'resolved' CHECK (resolution_status IN ('resolved', 'unresolved')),
  identity_source TEXT NOT NULL DEFAULT 'equity-endpoint' CHECK (
    identity_source IN ('equity-endpoint', 'watchlist-symbol')
  )
);

INSERT INTO instrument_catalog
SELECT
  replace(symbol, '.', '/'), source_name, description, short_description, instrument_type,
  instrument_sub_type, streamer_symbol, listed_market, market_time_instrument_collection,
  country_of_incorporation, country_of_taxation, underlying_product_type, is_etf, is_index,
  pre_ipo, active, is_closing_only, is_options_closing_only, is_illiquid,
  is_fractional_quantity_eligible, overnight_trading_permitted, bypass_manual_review, halted_at,
  stops_trading_at, lendability, borrow_rate, identity_refreshed_at, status_refreshed_at,
  created_at, updated_at, resolution_status, identity_source
FROM instrument_catalog_pre_symbology;

CREATE TABLE instrument_tick_sizes (
  symbol TEXT NOT NULL REFERENCES instrument_catalog(symbol) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'option')),
  tier_index INTEGER NOT NULL CHECK (tier_index >= 0),
  applies_to_symbol TEXT CHECK (applies_to_symbol IS NULL OR length(applies_to_symbol) <= 128),
  threshold REAL,
  tick_value REAL NOT NULL CHECK (tick_value > 0),
  PRIMARY KEY (symbol, kind, tier_index)
);

INSERT INTO instrument_tick_sizes
SELECT replace(symbol, '.', '/'), kind, tier_index, applies_to_symbol, threshold, tick_value
FROM instrument_tick_sizes_pre_symbology;

DROP TABLE instrument_tick_sizes_pre_symbology;
DROP TABLE instrument_catalog_pre_symbology;

CREATE INDEX instrument_catalog_status_refresh
  ON instrument_catalog(status_refreshed_at ASC, symbol ASC);

-- tastytrade market metrics.
DROP INDEX tastytrade_market_metrics_observed;
ALTER TABLE tastytrade_market_metrics RENAME TO tastytrade_market_metrics_pre_symbology;

CREATE TABLE tastytrade_market_metrics (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  iv_index_percent REAL NOT NULL CHECK (iv_index_percent >= 0),
  iv_rank_percent REAL NOT NULL CHECK (iv_rank_percent BETWEEN 0 AND 100),
  iv_percentile_percent REAL NOT NULL CHECK (iv_percentile_percent BETWEEN 0 AND 100),
  iv_index_5_day_change_points REAL,
  historical_volatility_30_day_percent REAL CHECK (
    historical_volatility_30_day_percent IS NULL OR historical_volatility_30_day_percent >= 0
  ),
  iv_hv_30_day_difference_points REAL,
  front_expiration TEXT,
  front_iv_percent REAL CHECK (front_iv_percent IS NULL OR front_iv_percent >= 0),
  back_expiration TEXT,
  back_iv_percent REAL CHECK (back_iv_percent IS NULL OR back_iv_percent >= 0),
  liquidity_rating REAL NOT NULL CHECK (liquidity_rating BETWEEN 0 AND 5),
  market_cap REAL CHECK (market_cap IS NULL OR market_cap >= 0),
  earnings_date TEXT,
  observed_at TEXT NOT NULL
);

INSERT INTO tastytrade_market_metrics
SELECT
  replace(symbol, '.', '/'), iv_index_percent, iv_rank_percent, iv_percentile_percent,
  iv_index_5_day_change_points, historical_volatility_30_day_percent,
  iv_hv_30_day_difference_points, front_expiration, front_iv_percent, back_expiration,
  back_iv_percent, liquidity_rating, market_cap, earnings_date, observed_at
FROM tastytrade_market_metrics_pre_symbology;

DROP TABLE tastytrade_market_metrics_pre_symbology;

CREATE INDEX tastytrade_market_metrics_observed
  ON tastytrade_market_metrics(observed_at DESC, symbol ASC);

-- tastytrade delayed quotes.
DROP INDEX tastytrade_market_quotes_observed;
ALTER TABLE tastytrade_market_quotes RENAME TO tastytrade_market_quotes_pre_symbology;

CREATE TABLE tastytrade_market_quotes (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  price REAL NOT NULL CHECK (price > 0),
  previous_close REAL NOT NULL CHECK (previous_close > 0),
  change_amount REAL NOT NULL,
  change_percent REAL NOT NULL,
  volume REAL CHECK (volume IS NULL OR volume >= 0),
  year_low REAL CHECK (year_low IS NULL OR year_low > 0),
  year_high REAL CHECK (year_high IS NULL OR year_high > 0),
  provider_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  CHECK (year_low IS NULL OR year_high IS NULL OR year_high > year_low)
);

INSERT INTO tastytrade_market_quotes
SELECT
  replace(symbol, '.', '/'), price, previous_close, change_amount, change_percent, volume,
  year_low, year_high, provider_updated_at, observed_at
FROM tastytrade_market_quotes_pre_symbology;

DROP TABLE tastytrade_market_quotes_pre_symbology;

CREATE INDEX tastytrade_market_quotes_observed
  ON tastytrade_market_quotes(observed_at DESC, symbol ASC);

-- Per-member source-neutral favorites. The cascade to the owning user row is preserved.
ALTER TABLE user_favorite_symbols RENAME TO user_favorite_symbols_pre_symbology;

CREATE TABLE user_favorite_symbols (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  symbol TEXT NOT NULL CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, symbol)
) WITHOUT ROWID;

INSERT INTO user_favorite_symbols
SELECT user_id, replace(symbol, '.', '/'), created_at
FROM user_favorite_symbols_pre_symbology;

DROP TABLE user_favorite_symbols_pre_symbology;

-- The published universe is a projection of the live list, so it is republished from the
-- converted rows rather than rewritten in place.
UPDATE public_market_universe
SET payload_json = coalesce(
  (
    SELECT json_object('symbols', json_group_array(symbol))
    FROM (SELECT symbol FROM internal_watchlist_items ORDER BY symbol ASC LIMIT 100)
  ),
  json_object('symbols', json_array())
)
WHERE id = 'primary';

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
  q.change_amount,
  q.change_percent,
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
