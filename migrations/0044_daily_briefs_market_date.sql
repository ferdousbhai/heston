-- The market date is already the brief's id and a field of its payload; a third copy in its own
-- column was written and never read.
ALTER TABLE daily_briefs DROP COLUMN market_date;
