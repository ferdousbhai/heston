-- Every row in this table is an executable order draft. Keep the D1 state machine
-- authoritative as new order kinds are added; a kind allowlist can silently miss one.
DROP INDEX brokerage_actions_one_trade_in_flight;

CREATE UNIQUE INDEX brokerage_actions_one_trade_in_flight
  ON brokerage_actions ((1))
  WHERE status IN ('pending', 'executing');
