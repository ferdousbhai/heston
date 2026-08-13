CREATE TABLE IF NOT EXISTS research_briefs (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS research_briefs_published
  ON research_briefs(published_at DESC);

CREATE TABLE IF NOT EXISTS brokerage_actions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('pending', 'denied', 'expired', 'executing', 'executed', 'failed')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  token_digest TEXT NOT NULL,
  provider_order_id TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  resolved_at TEXT,
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS brokerage_actions_pending
  ON brokerage_actions(status, expires_at);
