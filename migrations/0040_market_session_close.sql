-- The closing bell is stored with the session for the same reason the open is: only the
-- provider knows holidays and half days, so a countdown to close cannot be derived from a clock.
ALTER TABLE market_session ADD COLUMN closes_at TEXT;
