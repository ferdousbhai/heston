-- The Cloudflare daily-research agent now discovers, verifies, and refreshes catalysts in the
-- same run that publishes recommendations. The retired laptop producer has no remaining owner
-- able to re-verify or retract its rows, and its run ledger has no remaining reader or writer.
DROP VIEW upcoming_catalysts;

CREATE TABLE catalysts_next (
  id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (
    source_provider IN ('tastytrade', 'daily-research', 'dan')
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

INSERT INTO catalysts_next (
  id, source_provider, symbol, kind, title, description, event_date, timing,
  confidence, source_label, source_url, updated_at, last_seen_at
)
SELECT id, source_provider, symbol, kind, title, description, event_date, timing,
       confidence, source_label, source_url, updated_at, last_seen_at
FROM catalysts
WHERE source_provider <> 'codex-web';

DROP TABLE catalysts;
ALTER TABLE catalysts_next RENAME TO catalysts;

CREATE INDEX catalysts_symbol_event_date ON catalysts (symbol, event_date);

CREATE VIEW upcoming_catalysts AS
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, source_provider
FROM catalysts;

DROP TABLE catalyst_research_runs;
