-- `visitor-search` records a symbol a reader looked up on the public market screen.
-- It is the weakest live provenance there is: any other origin overwrites it, and it
-- never overwrites one. Rebuild forward-only because SQLite cannot extend a CHECK.
DROP INDEX IF EXISTS internal_watchlist_items_updated;

ALTER TABLE internal_watchlist_items RENAME TO internal_watchlist_items_before_visitor_search;

CREATE TABLE internal_watchlist_items (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  instrument_type TEXT NOT NULL CHECK (instrument_type = 'Equity'),
  origin TEXT NOT NULL CHECK (origin IN (
    'tastytrade-seed', 'visitor-search', 'scheduled-research', 'agent-discussion',
    'position-sync', 'trade-intent', 'owner'
  )),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO internal_watchlist_items
  (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
SELECT symbol, instrument_type, origin, metadata_json, created_at, updated_at
FROM internal_watchlist_items_before_visitor_search;

DROP TABLE internal_watchlist_items_before_visitor_search;

CREATE INDEX internal_watchlist_items_updated
  ON internal_watchlist_items(updated_at DESC);

-- The catalog is searched by name as well as by symbol once a reader can look up a
-- symbol the list does not carry yet.
CREATE INDEX IF NOT EXISTS instrument_catalog_resolved_description
  ON instrument_catalog(resolution_status, description);
