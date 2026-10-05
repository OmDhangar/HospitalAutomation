-- One queue, not two.
--
-- 0034 added arrived_at so Next would pass over bookings that had not checked
-- in. In use it split the desk's line into "arrived" and "not arrived" and
-- added a workflow the receptionist did not need. The queue is now simply
-- WAITING: Next calls the next patient, a patient who is not there is put on
-- hold, and Resume brings them back under the late-return rule. Nothing reads
-- this column any more, and it was never released, so it is dropped rather
-- than left as state with no meaning.

ALTER TABLE appointments DROP COLUMN IF EXISTS arrived_at;
