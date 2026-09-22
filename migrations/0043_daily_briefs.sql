-- The daily brief, in the channel's own shape, written by the private long-vol Workflow
-- through the BriefPublisher entrypoint. One row per market date; the payload is the
-- validated DailyBrief and is re-parsed on every read, so an incompatible row fails visibly.
CREATE TABLE daily_briefs (
  id TEXT PRIMARY KEY CHECK (id GLOB 'brief-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  market_date TEXT NOT NULL,
  published_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX daily_briefs_published_at ON daily_briefs(published_at);
