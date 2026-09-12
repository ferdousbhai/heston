-- Who published a brief. Any member's agent can replace the public brief, so the publication
-- needs an account behind it that the owner can reach when a brief has to be answered for --
-- the byline in the payload is a handle the member chose for readers and identifies nobody.
--
-- Private, and it stays that way: account identity is never public, so no public read, route,
-- or MCP tool may select this column. It is only ever read by a person with database access.
-- Nullable, and NULL has exactly two meanings: a brief published before this column existed,
-- or one whose publisher has since deleted their account. Every publish writes it, and the
-- brief outlives the account rather than the account taking public content down with it.
ALTER TABLE daily_recommendations
  ADD COLUMN published_by_user_id TEXT REFERENCES "user" ("id") ON DELETE SET NULL;
