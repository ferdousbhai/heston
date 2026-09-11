-- What survives of the retired Long Vol Telegram channel: one provider (the channel's public
-- preview), one contract (a post as plain text plus the links it carried). Telegram deleted
-- the channel's messages after a month until March 2026, so this is the whole recoverable
-- history and it grows no further. Imported by tools/import-channel-archive.mjs.
CREATE TABLE long_vol_channel_posts (
  post_id INTEGER PRIMARY KEY CHECK (post_id > 0),
  posted_at TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) > 0),
  links_json TEXT NOT NULL CHECK (json_valid(links_json)),
  imported_at TEXT NOT NULL
);

CREATE INDEX long_vol_channel_posts_posted ON long_vol_channel_posts(posted_at DESC, post_id DESC);
