-- 0006 is already applied. Enforce the normalized live-row contract forward-only
-- while leaving the immutable tastytrade seed provenance tables unrestricted.
CREATE TRIGGER internal_watchlist_items_validate_insert
BEFORE INSERT ON internal_watchlist_items
WHEN NEW.symbol IS NULL
  OR NEW.symbol NOT GLOB '[A-Z]*'
  OR NEW.symbol GLOB '*[^A-Z.]*'
  OR length(NEW.symbol) NOT BETWEEN 1 AND 8
  OR NEW.instrument_type <> 'Equity'
BEGIN
  SELECT RAISE(ABORT, 'invalid internal watchlist item');
END;

CREATE TRIGGER internal_watchlist_items_validate_update
BEFORE UPDATE OF symbol, instrument_type ON internal_watchlist_items
WHEN NEW.symbol IS NULL
  OR NEW.symbol NOT GLOB '[A-Z]*'
  OR NEW.symbol GLOB '*[^A-Z.]*'
  OR length(NEW.symbol) NOT BETWEEN 1 AND 8
  OR NEW.instrument_type <> 'Equity'
BEGIN
  SELECT RAISE(ABORT, 'invalid internal watchlist item');
END;
