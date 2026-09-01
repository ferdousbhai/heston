-- The snapshot needs only where the year started, to sort by return and label the move. Reading
-- the whole series for that meant every market request carried a year of closes for every
-- symbol; the series now travels on its own, and this column is what the snapshot reads instead.
ALTER TABLE year_candles ADD COLUMN year_ago_close REAL;

UPDATE year_candles
   SET year_ago_close = json_extract(closes_json, '$[0].close')
 WHERE json_valid(closes_json) AND json_array_length(closes_json) > 0;
