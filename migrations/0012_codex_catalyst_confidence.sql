-- Manual Codex research is exploratory even when it cites a first-party page.
-- Normalize legacy rows and make the trust boundary durable in D1.
DROP VIEW upcoming_catalysts;
DROP INDEX codex_web_catalysts_upcoming;

ALTER TABLE codex_web_catalysts RENAME TO codex_web_catalysts_before_estimated;

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
  confidence TEXT NOT NULL CHECK (confidence = 'estimated'),
  source_label TEXT NOT NULL CHECK (source_label GLOB 'Codex web · *'),
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

INSERT INTO codex_web_catalysts
  (id, symbol, kind, title, description, event_date, timing, confidence,
   source_label, source_url, updated_at, last_seen_at)
SELECT id, symbol, kind, title, description, event_date, timing, 'estimated',
       source_label, source_url, updated_at, last_seen_at
FROM codex_web_catalysts_before_estimated;

DROP TABLE codex_web_catalysts_before_estimated;

CREATE INDEX codex_web_catalysts_upcoming
  ON codex_web_catalysts(event_date, symbol);

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
