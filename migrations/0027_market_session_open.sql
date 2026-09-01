-- Pre-market is the one state a reader can count down from, so the cached session keeps the
-- opening bell alongside it. Only the provider knows about holidays and half days, so this is
-- stored rather than derived from a clock.
ALTER TABLE market_session ADD COLUMN opens_at TEXT;
