-- Realized volatility and the IV-HV gap were stored under the wrong unit: the
-- importer multiplied tastytrade's percent and point values by 100, so larger
-- readings were rejected outright and every value that did land is a
-- hundredfold. Neither column holds an observation. Clear them; the next
-- snapshot load rewrites the live rows.
UPDATE tastytrade_market_metrics
SET historical_volatility_30_day_percent = NULL,
    iv_hv_30_day_difference_points = NULL;
