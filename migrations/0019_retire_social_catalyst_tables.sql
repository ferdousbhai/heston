-- The X and Reddit catalyst producers are gone: X Search output is private discovery for the
-- daily brief and Reddit feeds brief evidence, so neither writes catalyst rows any more.
-- Storage without a writer cannot be re-verified, and a legacy row dated in the future would
-- sit on the public surface, and in the research agent's evidence, with nobody able to
-- refresh or retract it. The X table's own CHECK even admits `confirmed` confidence for rows
-- no producer can confirm. Retire the storage; the view keeps its column shape so a Worker
-- either side of this migration reads identical rows.
DROP VIEW upcoming_catalysts;
DROP TABLE x_catalysts;
DROP TABLE reddit_catalysts;

CREATE VIEW upcoming_catalysts AS
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, 'tastytrade' AS source_provider
FROM tastytrade_catalysts
UNION ALL
SELECT id, symbol, kind, title, description, event_date, timing, confidence,
       source_label, source_url, updated_at, last_seen_at, 'codex-web' AS source_provider
FROM codex_web_catalysts;
