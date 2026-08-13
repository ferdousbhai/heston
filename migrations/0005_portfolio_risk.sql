CREATE TABLE IF NOT EXISTS portfolio_risk_state (
  account_number TEXT PRIMARY KEY NOT NULL,
  high_water_nlv REAL NOT NULL CHECK (high_water_nlv > 0),
  activated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

UPDATE brokerage_actions
SET status = 'expired', error_code = 'ExecutingActionTakesPriority'
WHERE status = 'pending'
  AND EXISTS (SELECT 1 FROM brokerage_actions WHERE status = 'executing');

UPDATE brokerage_actions
SET status = 'expired', error_code = 'SupersededByPortfolioGuard'
WHERE status = 'pending'
  AND id NOT IN (
    SELECT id FROM brokerage_actions
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT 1
  );

CREATE UNIQUE INDEX IF NOT EXISTS brokerage_actions_one_trade_in_flight
  ON brokerage_actions ((1))
  WHERE status IN ('pending', 'executing')
    AND json_extract(payload_json, '$.kind') IN ('place_option_order', 'place_equity_order');
