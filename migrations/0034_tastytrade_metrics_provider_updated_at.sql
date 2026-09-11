-- When tastytrade itself last computed a symbol's metrics. The quotes table has carried the
-- provider's own instant since it was created; metrics only recorded when this Worker read
-- them, which says nothing about how old the reading was. Rows written before this column
-- exists have no provider instant, and are shown without one until the next refresh.
ALTER TABLE tastytrade_market_metrics ADD COLUMN provider_updated_at TEXT;
