-- Authenticated members may sync only source-neutral ticker favorites. The opaque
-- Better Auth user id remains private and cascades away with its owning user row.
CREATE TABLE user_favorite_symbols (
  user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  symbol TEXT NOT NULL CHECK (
    symbol GLOB '[A-Z]*'
    AND symbol NOT GLOB '*[^A-Z.]*'
    AND length(symbol) BETWEEN 1 AND 8
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, symbol)
) WITHOUT ROWID;
