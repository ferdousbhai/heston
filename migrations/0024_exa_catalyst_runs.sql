-- A favorite is a reader telling Heston which symbol matters to them, so it is also the
-- cheapest signal for where catalyst coverage is worth buying. `exa` is that producer:
-- one web search per symbol, at most once a month, recorded here so a symbol nobody has
-- researched can be told apart from one whose search legitimately found nothing.
CREATE TABLE catalyst_runs (
  symbol TEXT NOT NULL,
  source_provider TEXT NOT NULL CHECK (source_provider = 'exa'),
  ran_at TEXT NOT NULL,
  catalyst_count INTEGER NOT NULL DEFAULT 0 CHECK (catalyst_count >= 0),
  status TEXT NOT NULL CHECK (status IN ('running', 'complete', 'failed')),
  detail TEXT CHECK (detail IS NULL OR length(detail) BETWEEN 1 AND 500),
  PRIMARY KEY (symbol, source_provider)
);

CREATE TABLE catalysts_with_exa (
  id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (
    source_provider IN ('tastytrade', 'daily-research', 'dan', 'exa')
  ),
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'earnings', 'investor-event', 'product-event', 'regulatory', 'clinical',
    'conference', 'shareholder'
  )),
  title TEXT NOT NULL,
  description TEXT CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500),
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'estimated')),
  source_label TEXT NOT NULL,
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  CHECK (id GLOB source_provider || ':*')
);

DROP VIEW upcoming_catalysts;

INSERT INTO catalysts_with_exa (
  id, source_provider, symbol, kind, title, description, event_date, timing,
  confidence, source_label, source_url, updated_at, last_seen_at
)
SELECT id, source_provider, symbol, kind, title, description, event_date, timing,
       confidence, source_label, source_url, updated_at, last_seen_at
FROM catalysts;

DROP TABLE catalysts;
ALTER TABLE catalysts_with_exa RENAME TO catalysts;

CREATE INDEX catalysts_symbol_event_date ON catalysts (symbol, event_date);

CREATE VIEW upcoming_catalysts AS
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, source_provider
FROM catalysts;
