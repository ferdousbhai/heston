-- The public daily brief is retired: nothing deployed reads these tables since the commit that
-- removed the recommendations screen and the brief read tools shipped. Pushed on its own after
-- that deploy, as the working rules require for a drop. `recommendation_links` goes first
-- because it references `daily_recommendations`.
DROP TABLE IF EXISTS recommendation_links;
DROP TABLE IF EXISTS daily_recommendations;
