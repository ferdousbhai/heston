-- One provider -- members' own agents -- and one contract: a passage quoted verbatim from a page
-- this Worker re-read, attached to a symbol, with the member's own one-line reading of it. The
-- id is derived from (symbol, canonical url, normalized quote), so the same passage recorded
-- again refreshes the row it already has instead of stacking duplicate cards under a name.
--
-- `recorded_by_user_id` is private. No public read may select it: the card's only public
-- attribution is the byline the member chose, and the account id stays server-side the way every
-- other account-derived column does. It cascades away with its owning user row.
--
-- The text bounds mirror src/domain/symbol-evidence.ts, which is where they are decided and
-- where each carries its reason; SQL cannot import them, so the store restates them as the last
-- line of defence rather than as a second opinion.
CREATE TABLE symbol_evidence (
  id TEXT PRIMARY KEY,
  symbol TEXT NOT NULL CHECK (
    symbol GLOB '[A-Z0-9]*'
    AND symbol NOT GLOB '*[^A-Z0-9/]*'
    AND symbol NOT GLOB '*/*/*'
    AND symbol NOT GLOB '*/'
    AND length(symbol) BETWEEN 1 AND 10
  ),
  quote TEXT NOT NULL CHECK (length(quote) BETWEEN 1 AND 300),
  note TEXT CHECK (note IS NULL OR length(note) BETWEEN 1 AND 240),
  source_url TEXT NOT NULL CHECK (
    source_url GLOB 'https://*' AND length(source_url) BETWEEN 1 AND 2000
  ),
  source_title TEXT NOT NULL CHECK (length(source_title) BETWEEN 1 AND 180),
  byline TEXT CHECK (byline IS NULL OR length(byline) BETWEEN 1 AND 40),
  recorded_at TEXT NOT NULL,
  recorded_by_user_id TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE
);

-- The only read there is: the newest cards for one symbol.
CREATE INDEX symbol_evidence_symbol_recorded_at ON symbol_evidence (symbol, recorded_at DESC);
