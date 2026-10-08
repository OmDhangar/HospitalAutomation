-- Live capacity config, incremental ETA pace, and hybrid queue + slot sessions.
--
-- 1. Capacity is read from the doctor's standing settings on every allocation.
--    The per-day snapshot columns (token_quota, walk_in_reserved,
--    online_opens_minutes_before, walk_in_release_minutes) are no longer read;
--    they are dropped in a follow-up migration once this is deployed. What is
--    genuinely per-day stays: the counters, the release, and today's extra
--    capacity on top of the standing quota.
ALTER TABLE doctor_day_states ADD COLUMN IF NOT EXISTS extra_capacity INTEGER NOT NULL DEFAULT 0
  CHECK (extra_capacity >= 0);

-- Days that had extra capacity added keep it as a delta over the standing quota.
UPDATE doctor_day_states s
SET extra_capacity = GREATEST(0, s.token_quota - d.daily_token_quota)
FROM doctors d
WHERE d.id = s.doctor_id
  AND s.token_quota IS NOT NULL
  AND d.daily_token_quota IS NOT NULL
  AND s.service_date >= CURRENT_DATE - 1;

-- 2. The ETA pace, folded in on each Next by the update that already bumps
--    last_call_number. Reads never scan consultation history again.
ALTER TABLE doctor_day_states ADD COLUMN IF NOT EXISTS pace_minutes REAL;
ALTER TABLE doctor_day_states ADD COLUMN IF NOT EXISTS pace_samples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE doctor_day_states ADD COLUMN IF NOT EXISTS last_called_at TIMESTAMPTZ;

-- 3. Slot-session appointments are numbered S1, S2… by slot time, in their own
--    number space, so the token key now includes the session kind.
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'queue'
  CHECK (session_kind IN ('queue', 'slot'));

DROP INDEX IF EXISTS appointments_token_key;
CREATE UNIQUE INDEX IF NOT EXISTS appointments_token_key
  ON appointments (doctor_id, service_date, session_kind, token_number);

-- Booked evening slots waiting for their session to start. The tick sweep
-- reads only these, every minute, so the index holds nothing else.
CREATE INDEX IF NOT EXISTS appointments_slot_awaiting_session_idx
  ON appointments (scheduled_slot_at)
  WHERE status = 'CONFIRMED' AND session_kind = 'slot';
