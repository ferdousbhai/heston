-- Exactly one refresh may fan out to the provider at a time. The row is claimed with a single
-- conditional UPDATE, which D1 applies atomically, so a burst of visitors that all see stale data
-- produces one upstream refresh rather than one per request. The expiry is what makes it safe:
-- a refresh that dies partway through releases the claim by lapsing rather than wedging it shut.
CREATE TABLE market_refresh_lease (
  id TEXT PRIMARY KEY,
  expires_at TEXT NOT NULL
);

INSERT INTO market_refresh_lease (id, expires_at) VALUES ('public-snapshot', '1970-01-01T00:00:00.000Z');

-- The provider's own session state, cached with the rest of the snapshot. Deriving it from a
-- clock would miss holidays and half days, and asking the provider per visitor is the fan-out
-- this table exists to remove.
CREATE TABLE market_session (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  observed_at TEXT NOT NULL
);
