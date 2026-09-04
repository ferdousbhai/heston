-- Each member connects their own agent, so each member needs their own bearer token. Only the
-- SHA-256 digest of the whole token string is kept: the plaintext is shown once at issue and is
-- unrecoverable afterwards, so a database read never yields a working credential.
--
-- The token carries its own row id (`spice_<token_id>_<secret>`) because a constant-time scan
-- over every row is not possible. The id selects one row; only the digest comparison needs to
-- be constant time.
CREATE TABLE user_mcp_tokens (
  token_id     TEXT PRIMARY KEY,
  -- A token dies with the account, exactly as favorites do.
  user_id      TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  token_digest TEXT NOT NULL,
  label        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE INDEX user_mcp_tokens_user_id ON user_mcp_tokens (user_id);
