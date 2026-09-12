-- A member's own agent can now record a dated event it read on a page, so `member-research`
-- joins the producers a catalyst row may name. SQLite cannot alter a CHECK, so the table is
-- rebuilt forward-only exactly as 0024 admitted `exa`: copy every row into a table carrying the
-- wider constraint, then take back the old table's name, its index, and the view. The view
-- keeps the same column shape every reader already selects, so nothing above the store changes.
CREATE TABLE catalysts_with_member_research (
  id TEXT PRIMARY KEY,
  source_provider TEXT NOT NULL CHECK (
    source_provider IN ('tastytrade', 'daily-research', 'dan', 'exa', 'member-research')
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

INSERT INTO catalysts_with_member_research (
  id, source_provider, symbol, kind, title, description, event_date, timing,
  confidence, source_label, source_url, updated_at, last_seen_at
)
SELECT id, source_provider, symbol, kind, title, description, event_date, timing,
       confidence, source_label, source_url, updated_at, last_seen_at
FROM catalysts;

DROP TABLE catalysts;
ALTER TABLE catalysts_with_member_research RENAME TO catalysts;

CREATE INDEX catalysts_symbol_event_date ON catalysts (symbol, event_date);

CREATE VIEW upcoming_catalysts AS
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, source_provider
FROM catalysts;
