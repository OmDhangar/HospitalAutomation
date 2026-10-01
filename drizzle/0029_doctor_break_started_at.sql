-- When the doctor's current break began.
--
-- `paused` already says the doctor is away; it does not say since when, and
-- two things need that:
--
--   1. The patient page. "The doctor is on a break since 1:10 PM" is something
--      a patient can plan around; a bare "paused" next to a token that has not
--      moved for forty minutes reads as the queue being stuck.
--
--   2. Consultation durations. A patient who is CALLED or IN_CONSULTATION when
--      the doctor steps out stays that way until the doctor is back, so the
--      break lands inside their consultation and drags the median up for the
--      rest of the day. On resume the open consultation is shifted forward by
--      the length of the break, which needs to know when the break started.
--
-- Null whenever `paused` is false. Nullable and additive: rows written before
-- this migration simply have no recorded start.

ALTER TABLE doctor_day_states ADD COLUMN paused_at TIMESTAMPTZ;
