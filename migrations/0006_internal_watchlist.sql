-- The tastytrade lists are imported exactly once. Source rows and entry rows retain
-- the broker model for audit; only the normalized Equity rows drive Spice.
CREATE TABLE internal_watchlist_seed (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  status TEXT NOT NULL CHECK (status IN ('seeding', 'ready', 'failed')),
  attempt_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  seeded_at TEXT,
  error_code TEXT
);

CREATE TABLE internal_watchlist_items (
  symbol TEXT PRIMARY KEY CHECK (symbol GLOB '[A-Z]*' AND length(symbol) BETWEEN 1 AND 8),
  instrument_type TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN (
    'tastytrade-seed', 'owner', 'agent-discussion', 'scheduled-research', 'trade-intent'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX internal_watchlist_items_updated
  ON internal_watchlist_items(updated_at DESC);

CREATE TABLE internal_watchlist_seed_sources (
  id TEXT PRIMARY KEY,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('private', 'public')),
  source_index INTEGER NOT NULL CHECK (source_index >= 0),
  name TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  UNIQUE(source_kind, source_index)
);

CREATE TABLE internal_watchlist_seed_entries (
  source_id TEXT NOT NULL REFERENCES internal_watchlist_seed_sources(id) ON DELETE CASCADE,
  entry_index INTEGER NOT NULL CHECK (entry_index >= 0),
  broker_symbol TEXT,
  instrument_type TEXT,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  PRIMARY KEY(source_id, entry_index)
);

CREATE INDEX internal_watchlist_seed_entries_symbol
  ON internal_watchlist_seed_entries(broker_symbol);
