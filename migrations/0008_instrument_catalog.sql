-- The catalog is a typed projection of tastytrade's Equity model. Stable identity
-- and volatile trading status have separate refresh timestamps; raw provider JSON
-- is intentionally not retained.
CREATE TABLE instrument_catalog (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z]*'
    AND symbol NOT GLOB '*[^A-Z.]*'
    AND length(symbol) BETWEEN 1 AND 8
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
  updated_at TEXT NOT NULL
);

CREATE INDEX instrument_catalog_status_refresh
  ON instrument_catalog(status_refreshed_at ASC, symbol ASC);

-- tastytrade currently documents each tick-size field as one object, but its wire
-- format can contain tiers. Rows preserve that ordered structure without a JSON blob.
CREATE TABLE instrument_tick_sizes (
  symbol TEXT NOT NULL REFERENCES instrument_catalog(symbol) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('equity', 'option')),
  tier_index INTEGER NOT NULL CHECK (tier_index >= 0),
  applies_to_symbol TEXT CHECK (applies_to_symbol IS NULL OR length(applies_to_symbol) <= 128),
  threshold REAL,
  tick_value REAL NOT NULL CHECK (tick_value > 0),
  PRIMARY KEY (symbol, kind, tier_index)
);

