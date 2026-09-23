-- The exact order a submission sent, beside the action it was built from.
--
-- `payload_json` holds the caller-facing action tuple (underlying, expiry, type, strike), not
-- the contract it resolved to. Reconciliation used to rebuild the order by re-resolving that
-- tuple against the live option chain, which requires the contract to still be listed, active
-- and, for an opening order, not closing-only. An ambiguous 0DTE submission reconciled the next
-- morning, or one whose contract had since gone closing-only, could therefore never be matched:
-- the account stayed quarantined until someone edited this table by hand.
--
-- The resolved order is known exactly at claim time, so it is stored then and reconciliation
-- fingerprints against it with no chain lookup. Nullable because rows claimed before this column
-- existed have no resolved order; those still fall back to resolving the stored tuple.
ALTER TABLE broker_submissions
  ADD COLUMN resolved_payload_json TEXT
  CHECK (resolved_payload_json IS NULL OR json_valid(resolved_payload_json));
