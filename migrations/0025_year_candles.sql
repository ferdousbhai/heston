-- A year of daily closes changes once a session, so it is cached here rather than streamed to
-- every client on every connect. One row per symbol: the refresh replaces the series whole,
-- and `as_of` is what makes the read-through refresh idempotent within a market day.
CREATE TABLE year_candles (
  symbol TEXT PRIMARY KEY,
  as_of TEXT NOT NULL,
  closes_json TEXT NOT NULL CHECK (json_valid(closes_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX year_candles_as_of ON year_candles (as_of);
