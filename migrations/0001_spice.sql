CREATE TABLE research_briefs (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX research_briefs_published
  ON research_briefs(published_at DESC);

CREATE TABLE brokerage_actions (
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

CREATE INDEX brokerage_actions_pending
  ON brokerage_actions(status, expires_at);

CREATE UNIQUE INDEX brokerage_actions_one_trade_in_flight
  ON brokerage_actions ((1))
  WHERE status IN ('pending', 'executing')
    AND json_extract(payload_json, '$.kind') IN ('place_option_order', 'place_equity_order');

CREATE TABLE catalysts (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'earnings', 'investor-event', 'product-event', 'regulatory', 'clinical',
    'conference', 'shareholder'
  )),
  title TEXT NOT NULL,
  event_date TEXT NOT NULL CHECK (event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  timing TEXT NOT NULL CHECK (timing IN ('pre-market', 'intraday', 'after-hours', 'unknown')),
  confidence TEXT NOT NULL CHECK (confidence IN ('confirmed', 'estimated')),
  source_name TEXT NOT NULL,
  source_url TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE INDEX catalysts_upcoming ON catalysts(event_date, symbol);
CREATE INDEX catalysts_symbol ON catalysts(symbol, event_date);

CREATE TABLE catalyst_research_runs (
  id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  symbol_count INTEGER NOT NULL,
  accepted_count INTEGER,
  rejected_count INTEGER,
  error_code TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX catalyst_research_runs_started
  ON catalyst_research_runs(started_at DESC);

CREATE TABLE "user" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL UNIQUE,
  "emailVerified" INTEGER NOT NULL,
  "image" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "session" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "expiresAt" DATE NOT NULL,
  "token" TEXT NOT NULL UNIQUE,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

CREATE TABLE "account" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "accessTokenExpiresAt" DATE,
  "refreshTokenExpiresAt" DATE,
  "scope" TEXT,
  "password" TEXT,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE TABLE "verification" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "identifier" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "expiresAt" DATE NOT NULL,
  "createdAt" DATE NOT NULL,
  "updatedAt" DATE NOT NULL
);

CREATE INDEX "session_userId_idx" ON "session" ("userId");
CREATE INDEX "account_userId_idx" ON "account" ("userId");
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");

CREATE TABLE portfolio_risk_state (
  account_number TEXT PRIMARY KEY NOT NULL,
  high_water_nlv REAL NOT NULL CHECK (high_water_nlv > 0),
  activated_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
