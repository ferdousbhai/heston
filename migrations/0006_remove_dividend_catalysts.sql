CREATE TABLE catalysts_without_dividends (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'earnings', 'investor-event', 'product-event', 'regulatory', 'clinical',
    'conference', 'shareholder'
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

INSERT INTO catalysts_without_dividends
SELECT * FROM catalysts
WHERE kind NOT IN ('dividend-ex', 'dividend-pay');

DROP TABLE catalysts;
ALTER TABLE catalysts_without_dividends RENAME TO catalysts;

CREATE INDEX catalysts_upcoming ON catalysts(event_date, symbol);
CREATE INDEX catalysts_symbol ON catalysts(symbol, event_date);
