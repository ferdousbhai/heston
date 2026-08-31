-- Every catalyst table already had the same twelve columns and the same upsert; only the id
-- and source_label CHECK prefixes told them apart, and each new producer cost a migration, a
-- table, and another arm on the view. One table with a source_provider column says the same
-- thing, and a new producer now costs a new value.
--
-- The per-producer CHECKs that carried real meaning are kept: an id still names its producer,
-- and 0019's lesson stands — a row is only worth storing if its producer can re-verify it,
-- which last_seen_at is what records.
DROP VIEW upcoming_catalysts;

CREATE TABLE catalysts (
  id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (
    source_provider IN ('tastytrade', 'codex-web', 'daily-research', 'dan')
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
  -- An id still names the producer that wrote it, so a row can always be traced back to
  -- something that can refresh or retract it.
  CHECK (id GLOB source_provider || ':*')
);

INSERT INTO catalysts (
  id, source_provider, symbol, kind, title, description, event_date, timing,
  confidence, source_label, source_url, updated_at, last_seen_at
)
SELECT id, 'tastytrade', symbol, kind, title, description, event_date, timing,
       confidence, source_label, source_url, updated_at, last_seen_at
FROM tastytrade_catalysts;

INSERT INTO catalysts (
  id, source_provider, symbol, kind, title, description, event_date, timing,
  confidence, source_label, source_url, updated_at, last_seen_at
)
SELECT id, 'codex-web', symbol, kind, title, description, event_date, timing,
       confidence, source_label, source_url, updated_at, last_seen_at
FROM codex_web_catalysts;

DROP TABLE tastytrade_catalysts;
DROP TABLE codex_web_catalysts;

CREATE INDEX catalysts_symbol_event_date ON catalysts (symbol, event_date);

-- The view keeps its column shape, so a Worker either side of this migration reads identical
-- rows and nothing downstream has to know the storage changed.
CREATE VIEW upcoming_catalysts AS
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, source_provider
FROM catalysts;
