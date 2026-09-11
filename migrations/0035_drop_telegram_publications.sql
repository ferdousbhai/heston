-- The Telegram channel is retired and the deploy before this one stopped reading the
-- publication ledger, so the table can go in its own step. Nothing else references it.
DROP TABLE daily_recommendation_telegram_publications;
