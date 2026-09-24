-- A 52-week high equal to the low is a legitimate reading: a name whose price has not moved
-- all year, or that has traded for one price since it listed. The read model already shows it
-- as no range position; only an inverted range is a broken frame. SQLite cannot relax a table
-- CHECK in place, so the table is rebuilt with every other constraint unchanged. No view reads
-- it since 0017 dropped the mixed-source one.
CREATE TABLE tastytrade_market_quotes_equal_range (
  symbol TEXT PRIMARY KEY CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  price REAL NOT NULL CHECK (price > 0),
  previous_close REAL NOT NULL CHECK (previous_close > 0),
  volume REAL CHECK (volume IS NULL OR volume >= 0),
  year_low REAL CHECK (year_low IS NULL OR year_low > 0),
  year_high REAL CHECK (year_high IS NULL OR year_high > 0),
  provider_updated_at TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  CHECK (year_low IS NULL OR year_high IS NULL OR year_high >= year_low)
);

INSERT INTO tastytrade_market_quotes_equal_range
  (symbol, price, previous_close, volume, year_low, year_high, provider_updated_at, observed_at)
SELECT symbol, price, previous_close, volume, year_low, year_high, provider_updated_at, observed_at
FROM tastytrade_market_quotes;

DROP TABLE tastytrade_market_quotes;
ALTER TABLE tastytrade_market_quotes_equal_range RENAME TO tastytrade_market_quotes;

CREATE INDEX tastytrade_market_quotes_observed
  ON tastytrade_market_quotes(observed_at DESC, symbol ASC);
