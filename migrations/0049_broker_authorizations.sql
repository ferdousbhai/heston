-- A member's brokerage connection between the CLI starting it and redeeming it: who started it,
-- which loopback port their CLI is listening on, and until when. It holds no credential. The
-- state is kept only as its SHA-256 digest, so a database read cannot be replayed through the
-- callback; the refresh token the connection yields goes to the member's keyring, never here.
--
-- The broker and port bounds live in code (`src/domain/broker-authorization.ts`) rather than in
-- CHECK constraints, so adding a broker stays an adapter and its id, not a table rebuild.
CREATE TABLE broker_authorizations (
  state_digest  TEXT PRIMARY KEY,
  -- A pending connection dies with the account, exactly as an agent token does.
  user_id       TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  broker        TEXT NOT NULL,
  loopback_port INTEGER NOT NULL,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);

CREATE INDEX broker_authorizations_user_id ON broker_authorizations (user_id);
CREATE INDEX broker_authorizations_expires_at ON broker_authorizations (expires_at);
