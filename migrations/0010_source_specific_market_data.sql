-- Source tables are authoritative. Views may compose them for display, but no
-- provider may write facts into another provider's table.
CREATE TABLE tastytrade_market_metrics (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z]*' AND symbol NOT GLOB '*[^A-Z.]*' AND length(symbol) BETWEEN 1 AND 8
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

CREATE INDEX tastytrade_market_metrics_observed
  ON tastytrade_market_metrics(observed_at DESC, symbol ASC);

CREATE TABLE tastytrade_market_quotes (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z]*' AND symbol NOT GLOB '*[^A-Z.]*' AND length(symbol) BETWEEN 1 AND 8
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

CREATE INDEX tastytrade_market_quotes_observed
  ON tastytrade_market_quotes(observed_at DESC, symbol ASC);

CREATE TABLE tastytrade_catalysts (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tastytrade:*'),
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind = 'earnings'),
  title TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'estimated')),
  source_label TEXT NOT NULL CHECK (source_label = 'tastytrade market metrics'),
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE x_catalysts (
  id TEXT PRIMARY KEY CHECK (id GLOB 'xai-x-search:*'),
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder'
  )),
  title TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'estimated')),
  source_label TEXT NOT NULL CHECK (source_label = 'Grok 4.6 X research'),
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE reddit_catalysts (
  id TEXT PRIMARY KEY CHECK (id GLOB 'reddit:*'),
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder'
  )),
  title TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence = 'estimated'),
  source_label TEXT NOT NULL CHECK (source_label = 'Reddit · r/wallstreetbets'),
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE codex_web_catalysts (
  id TEXT PRIMARY KEY CHECK (id GLOB 'codex-web:*'),
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'investor-event', 'product-event', 'regulatory', 'clinical', 'conference', 'shareholder'
  )),
  title TEXT NOT NULL,
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'estimated')),
  source_label TEXT NOT NULL CHECK (source_label GLOB 'Codex web · *'),
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Fail the migration instead of silently losing an unrecognized legacy source.
CREATE TABLE catalyst_source_migration_guard (
  unexpected_count INTEGER NOT NULL CHECK (unexpected_count = 0)
);

INSERT INTO catalyst_source_migration_guard
SELECT count(*) FROM catalysts
WHERE source_name <> 'tastytrade market metrics'
  AND id NOT GLOB 'xai-x-search:*'
  AND id NOT GLOB 'reddit:*'
  AND id NOT GLOB 'codex-web:*';

INSERT INTO tastytrade_catalysts
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_name, source_url, updated_at, last_seen_at
FROM catalysts WHERE source_name = 'tastytrade market metrics';

INSERT INTO x_catalysts
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_name, source_url, updated_at, last_seen_at
FROM catalysts WHERE id GLOB 'xai-x-search:*';

INSERT INTO reddit_catalysts
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_name, source_url, updated_at, last_seen_at
FROM catalysts WHERE id GLOB 'reddit:*';

INSERT INTO codex_web_catalysts
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_name, source_url, updated_at, last_seen_at
FROM catalysts WHERE id GLOB 'codex-web:*';

DROP TABLE catalyst_source_migration_guard;
DROP INDEX catalysts_upcoming;
DROP INDEX catalysts_symbol;
DROP TABLE catalysts;

CREATE INDEX tastytrade_catalysts_upcoming ON tastytrade_catalysts(event_date, symbol);
CREATE INDEX x_catalysts_upcoming ON x_catalysts(event_date, symbol);
CREATE INDEX reddit_catalysts_upcoming ON reddit_catalysts(event_date, symbol);
CREATE INDEX codex_web_catalysts_upcoming ON codex_web_catalysts(event_date, symbol);

CREATE VIEW upcoming_catalysts AS
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, 'tastytrade' AS source_provider
FROM tastytrade_catalysts
UNION ALL
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, 'x' AS source_provider
FROM x_catalysts
UNION ALL
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, 'reddit' AS source_provider
FROM reddit_catalysts
UNION ALL
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, 'codex-web' AS source_provider
FROM codex_web_catalysts;

-- Public display data is a read-only projection. It contains no account facts or
-- watchlist provenance, and retains separate observation times for each source contract.
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
