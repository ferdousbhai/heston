CREATE TABLE public_market_universe (
  id TEXT PRIMARY KEY CHECK (id = 'primary'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  updated_at TEXT NOT NULL
);
