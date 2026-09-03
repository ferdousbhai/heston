-- The order draft/confirm ceremony is gone: the agent now runs on the member's own machine,
-- so withholding a confirmation token from it no longer buys a separate approving channel.
-- What survives is the part that was never about confirmation -- the quarantine.
--
-- A broker submission that returns 2xx but cannot be verified may or may not have reached the
-- market. Refusing while an order is live does not cover it, because an ambiguous order that
-- filled immediately is no longer live and a retry would double-fill. So an ambiguous
-- submission is recorded here with the payload reconciliation needs to fingerprint it against
-- broker order history, and that account places nothing further until it resolves.
--
-- Rows appear only when a submission goes ambiguous. A successful placement writes nothing.
-- It also stays the record of what was submitted, because a price-only replacement needs the
-- original order's shape: `order-intent` resolves it from here and then requires the broker's
-- live order to echo it, so a model can never replace an order this server never characterized.
-- Sourcing that shape from the broker alone would discard the two-source agreement check.
CREATE TABLE broker_submissions (
  id                TEXT PRIMARY KEY,
  broker_id         TEXT NOT NULL,
  account_number    TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  submitted_at      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('unresolved', 'executed', 'failed')),
  error_code        TEXT,
  provider_order_id TEXT
);

-- The quarantine is per broker account, never global: one member's unresolved submission must
-- not stop another member from trading their own account.
CREATE UNIQUE INDEX broker_submissions_one_unresolved_per_account
  ON broker_submissions (broker_id, account_number)
  WHERE status = 'unresolved';

CREATE INDEX broker_submissions_account_submitted_at
  ON broker_submissions (broker_id, account_number, submitted_at);

-- Replacement lookups are by the broker's own order id.
CREATE INDEX broker_submissions_provider_order_id
  ON broker_submissions (provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- Carry forward the orders already placed. Without this, replacing an order submitted before
-- this deploy would fail to find its source shape. The old rows predate multi-user, so they are
-- all tastytrade and all the owner's; the account number is unknown per-row and is not needed,
-- since replacement looks up by provider order id and the broker re-verifies the match.
INSERT INTO broker_submissions
  (id, broker_id, account_number, payload_json, submitted_at, status, provider_order_id)
SELECT id, 'tastytrade', '', payload_json, COALESCE(resolved_at, created_at), 'executed', provider_order_id
  FROM brokerage_actions
 WHERE status = 'executed' AND provider_order_id IS NOT NULL;

-- `brokerage_actions` is deliberately left in place. The live deployment still reads it until
-- this code ships, and a migration that drops a table the running code reads leaves the schema
-- ahead of the deploy with no rollback. It is dropped in a later push, once this is deployed.
