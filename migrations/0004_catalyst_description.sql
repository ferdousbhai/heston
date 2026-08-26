ALTER TABLE catalysts
  ADD COLUMN description TEXT
  CHECK (description IS NULL OR length(description) BETWEEN 1 AND 500);

-- This singleton is derived and repopulates on the next owner sync. Clear any
-- pre-v2 payload that may still contain source watchlist names or membership.
DELETE FROM public_market_universe;
