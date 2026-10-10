-- 0045_evidence_history.sql — IPD sheets plan Rev 5.1: the record History view.
--
-- "Who made this record, how and when": the evidence log's events for one record, found by the
-- record's id. Partial, because events without an object (a page view) are never looked up this way.
--
-- On the partitioned parent this cannot be CONCURRENTLY; it is built on each monthly partition with a
-- short lock. 0044 ships in the same release, so the table is empty when this runs in production.
-- Written for the runner v2.

CREATE INDEX IF NOT EXISTS acct_events_object_idx ON acct_events (hospital_id, object_id) WHERE object_id IS NOT NULL;
