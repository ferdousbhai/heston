-- The public output has one product name: daily recommendations. Historical rows are rewritten
-- so every reader sees the same contract, while recommendation_links keeps a durable URL identity
-- that prevents a page from being selected again on a later market date.
CREATE TABLE daily_recommendations_next (
  id TEXT PRIMARY KEY,
  published_at TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO daily_recommendations_next (id, published_at, payload_json, created_at)
SELECT
  CASE
    WHEN id GLOB 'brief-*' THEN 'recommendations-' || substr(id, 7)
    ELSE id
  END,
  published_at,
  json_set(
    json_remove(payload_json, '$.ideas', '$.readingList'),
    '$.id', CASE
      WHEN id GLOB 'brief-*' THEN 'recommendations-' || substr(id, 7)
      ELSE id
    END,
    '$.recommendations', json(COALESCE((
      SELECT json_group_array(json_set(
        json_remove(idea.value, '$.play'),
        '$.recommendedOrder', json_object(
          'kind', 'legacy-unstructured',
          'label', CASE
            WHEN json_type(idea.value, '$.play') = 'text'
              AND length(json_extract(idea.value, '$.play')) BETWEEN 1 AND 200
              THEN json_extract(idea.value, '$.play')
            ELSE NULL
          END
        )
      ))
      FROM json_each(research_briefs.payload_json, '$.ideas') AS idea
    ), '[]')),
    '$.links', json(COALESCE((
      SELECT json_group_array(json_object(
        'title', json_extract(link.value, '$.title'),
        'description', json_extract(link.value, '$.reason'),
        'url', json_extract(link.value, '$.url')
      ))
      FROM json_each(research_briefs.payload_json, '$.readingList') AS link
    ), '[]'))
  ),
  created_at
FROM research_briefs;

CREATE TABLE daily_recommendation_telegram_publications_next (
  daily_recommendations_id TEXT NOT NULL
    REFERENCES daily_recommendations_next(id) ON DELETE CASCADE,
  message_index INTEGER NOT NULL CHECK (message_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'delivered', 'ambiguous', 'failed')),
  telegram_message_id INTEGER CHECK (telegram_message_id >= 0),
  error_code TEXT,
  reserved_at TEXT NOT NULL CHECK (julianday(reserved_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  PRIMARY KEY (daily_recommendations_id, message_index),
  CHECK (
    (status = 'reserved' AND telegram_message_id IS NULL AND error_code IS NULL AND resolved_at IS NULL)
    OR (status = 'delivered' AND telegram_message_id IS NOT NULL AND error_code IS NULL
      AND resolved_at IS NOT NULL)
    OR (status IN ('ambiguous', 'failed') AND telegram_message_id IS NULL
      AND error_code IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

INSERT INTO daily_recommendation_telegram_publications_next (
  daily_recommendations_id, message_index, status, telegram_message_id,
  error_code, reserved_at, resolved_at
)
SELECT
  CASE
    WHEN brief_id GLOB 'brief-*' THEN 'recommendations-' || substr(brief_id, 7)
    ELSE brief_id
  END,
  message_index,
  status,
  telegram_message_id,
  error_code,
  reserved_at,
  resolved_at
FROM research_brief_telegram_publications;

DROP TRIGGER research_brief_telegram_publications_immutable_identity;
DROP TABLE research_brief_telegram_publications;
DROP TABLE research_briefs;

ALTER TABLE daily_recommendations_next RENAME TO daily_recommendations;
ALTER TABLE daily_recommendation_telegram_publications_next
  RENAME TO daily_recommendation_telegram_publications;

CREATE INDEX daily_recommendations_published
  ON daily_recommendations(published_at DESC);

CREATE TRIGGER daily_recommendation_telegram_publications_immutable_identity
BEFORE UPDATE ON daily_recommendation_telegram_publications
WHEN NEW.daily_recommendations_id != OLD.daily_recommendations_id
  OR NEW.message_index != OLD.message_index
  OR NEW.reserved_at != OLD.reserved_at
  OR OLD.status != 'reserved'
  OR NEW.status NOT IN ('delivered', 'ambiguous', 'failed')
BEGIN SELECT RAISE(ABORT, 'DailyRecommendationTelegramPublicationTransitionInvalid'); END;

CREATE TABLE recommendation_links (
  url TEXT PRIMARY KEY CHECK (url GLOB 'https://*'),
  daily_recommendations_id TEXT NOT NULL
    REFERENCES daily_recommendations(id) ON DELETE RESTRICT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 180),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 180),
  preview_image_url TEXT CHECK (
    preview_image_url IS NULL OR preview_image_url GLOB 'https://*'
  ),
  first_published_at TEXT NOT NULL CHECK (julianday(first_published_at) IS NOT NULL)
);

INSERT INTO recommendation_links (
  url, daily_recommendations_id, title, description, preview_image_url, first_published_at
)
SELECT url, id, title, description, NULL, published_at
FROM (
  SELECT
    recommendation.id,
    recommendation.published_at,
    json_extract(link.value, '$.url') AS url,
    json_extract(link.value, '$.title') AS title,
    json_extract(link.value, '$.description') AS description,
    row_number() OVER (
      PARTITION BY json_extract(link.value, '$.url')
      ORDER BY recommendation.published_at ASC, recommendation.id ASC
    ) AS publication_order
  FROM daily_recommendations AS recommendation,
       json_each(recommendation.payload_json, '$.links') AS link
)
WHERE publication_order = 1;

CREATE INDEX recommendation_links_published
  ON recommendation_links(first_published_at DESC);

-- A rerun may update the same market date's recommendation, but a later daily recommendation
-- may not silently republish a URL already shown to readers.
CREATE TRIGGER recommendation_links_no_republication
BEFORE INSERT ON recommendation_links
WHEN EXISTS (
  SELECT 1
  FROM recommendation_links AS existing
  WHERE existing.url = NEW.url
    AND existing.daily_recommendations_id != NEW.daily_recommendations_id
)
BEGIN SELECT RAISE(ABORT, 'RecommendationLinkAlreadyPublished'); END;
