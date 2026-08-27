-- Active positions join the same maintained list as owner and agent discoveries.
-- Rebuild forward-only because SQLite cannot extend the original origin CHECK.
ALTER TABLE internal_watchlist_seed ADD COLUMN finalized_at TEXT;

-- A bounded ready list was finalized by the pre-marker implementation. Preserve
-- its explicit deletions instead of rebuilding it from immutable provenance.
UPDATE internal_watchlist_seed
SET finalized_at = seeded_at
WHERE status = 'ready'
  AND seeded_at IS NOT NULL
  AND (SELECT count(*) FROM internal_watchlist_items) <= 100;

DROP TRIGGER IF EXISTS internal_watchlist_items_validate_insert;
DROP TRIGGER IF EXISTS internal_watchlist_items_validate_update;
DROP INDEX IF EXISTS internal_watchlist_items_updated;

ALTER TABLE internal_watchlist_items RENAME TO internal_watchlist_items_before_position_origin;

CREATE TABLE internal_watchlist_items (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z]*'
    AND symbol NOT GLOB '*[^A-Z.]*'
    AND length(symbol) BETWEEN 1 AND 8
  ),
  instrument_type TEXT NOT NULL CHECK (instrument_type = 'Equity'),
  origin TEXT NOT NULL CHECK (origin IN (
    'tastytrade-seed', 'scheduled-research', 'agent-discussion',
    'position-sync', 'trade-intent', 'owner'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO internal_watchlist_items
  (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
SELECT symbol, instrument_type, origin, metadata_json, created_at, updated_at
FROM internal_watchlist_items_before_position_origin;

DROP TABLE internal_watchlist_items_before_position_origin;

CREATE INDEX internal_watchlist_items_updated
  ON internal_watchlist_items(updated_at DESC);
