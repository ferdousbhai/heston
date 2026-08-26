-- Some tastytrade watchlist Equity symbols are absent from both Equity definition
-- endpoints. Keep the symbol explicitly unresolved so one anomaly neither invents
-- identity data nor blocks the rest of the catalog and catalyst bootstrap.
ALTER TABLE instrument_catalog
  ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'resolved'
  CHECK (resolution_status IN ('resolved', 'unresolved'));

ALTER TABLE instrument_catalog
  ADD COLUMN identity_source TEXT NOT NULL DEFAULT 'equity-endpoint'
  CHECK (identity_source IN ('equity-endpoint', 'watchlist-symbol'));

