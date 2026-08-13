CREATE TABLE catalysts_next (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'earnings', 'dividend-ex', 'dividend-pay', 'investor-event', 'product-event',
    'regulatory', 'clinical', 'conference', 'shareholder'
  )),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'estimated')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

INSERT INTO catalysts_next SELECT * FROM catalysts;
DROP TABLE catalysts;
ALTER TABLE catalysts_next RENAME TO catalysts;

CREATE INDEX catalysts_upcoming ON catalysts(event_date, symbol);
CREATE INDEX catalysts_symbol ON catalysts(symbol, event_date);

CREATE TABLE catalyst_research_runs (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  symbol_count INTEGER NOT NULL,
  accepted_count INTEGER,
  rejected_count INTEGER,
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX catalyst_research_runs_started
  ON catalyst_research_runs(started_at DESC);
