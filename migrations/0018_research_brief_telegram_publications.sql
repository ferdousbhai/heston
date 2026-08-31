PRAGMA foreign_keys = ON;

-- Reserving before the external request is the point after which a replay must
-- never assume that Telegram did not accept the message.
CREATE TABLE research_brief_telegram_publications (
  brief_id TEXT NOT NULL REFERENCES research_briefs(id) ON DELETE CASCADE,
  message_index INTEGER NOT NULL CHECK (message_index >= 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'delivered', 'ambiguous', 'failed')),
  telegram_message_id INTEGER CHECK (telegram_message_id >= 0),
  error_code TEXT,
  reserved_at TEXT NOT NULL CHECK (julianday(reserved_at) IS NOT NULL),
  resolved_at TEXT CHECK (resolved_at IS NULL OR julianday(resolved_at) IS NOT NULL),
  PRIMARY KEY (brief_id, message_index),
  CHECK (
    (status = 'reserved' AND telegram_message_id IS NULL AND error_code IS NULL AND resolved_at IS NULL)
    OR (status = 'delivered' AND telegram_message_id IS NOT NULL AND error_code IS NULL AND resolved_at IS NOT NULL)
    OR (status IN ('ambiguous', 'failed') AND telegram_message_id IS NULL
      AND error_code IS NOT NULL AND resolved_at IS NOT NULL)
  )
);

CREATE TRIGGER research_brief_telegram_publications_immutable_identity
BEFORE UPDATE ON research_brief_telegram_publications
WHEN NEW.brief_id != OLD.brief_id
  OR NEW.message_index != OLD.message_index
  OR NEW.reserved_at != OLD.reserved_at
  OR OLD.status != 'reserved'
  OR NEW.status NOT IN ('delivered', 'ambiguous', 'failed')
BEGIN SELECT RAISE(ABORT, 'ResearchBriefTelegramPublicationTransitionInvalid'); END;
