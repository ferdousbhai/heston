-- The drawdown guard measures against a high-water net liquidating value per account. That was
-- keyed by account number alone, which was correct while one credential reached one broker.
-- Now each member presents their own credential and a second broker can be added by adding an
-- adapter, so two brokers could issue the same account number and share a high-water mark --
-- silently widening or narrowing one member's loss budget with another's portfolio value.
--
-- SQLite cannot alter a primary key, so the table is rebuilt. Existing rows all predate
-- multi-broker support and are tastytrade by construction.
CREATE TABLE portfolio_risk_state_next (
  broker_id      TEXT NOT NULL,
  account_number TEXT NOT NULL,
  high_water_nlv REAL NOT NULL CHECK (high_water_nlv > 0),
  activated_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  PRIMARY KEY (broker_id, account_number)
) WITHOUT ROWID;

INSERT INTO portfolio_risk_state_next
  (broker_id, account_number, high_water_nlv, activated_at, updated_at)
SELECT 'tastytrade', account_number, high_water_nlv, activated_at, updated_at
  FROM portfolio_risk_state;

DROP TABLE portfolio_risk_state;

ALTER TABLE portfolio_risk_state_next RENAME TO portfolio_risk_state;
