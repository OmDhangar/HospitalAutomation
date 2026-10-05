-- Arrival-aware queue, FIFO priority, late-return placement and a per-doctor
-- daily token quota. Additive only: every existing row stays valid, nothing is
-- renamed, and no token is ever rewritten.
--
-- Rollback: drop the columns and the index below. No existing data is changed
-- except the arrival/priority backfill, which only fills new columns.

-- 1. Arrival is tracked separately from status. A WhatsApp or web booking is
--    WAITING the moment it is made, wherever the patient is; Next only calls
--    someone whose arrival has been confirmed.
ALTER TABLE appointments ADD COLUMN arrived_at TIMESTAMPTZ;
--> statement-breakpoint

-- 2. Priority is first-come first-served by when priority was given, not by
--    when the patient joined the queue.
ALTER TABLE appointments ADD COLUMN priority_seq INTEGER;
--> statement-breakpoint

-- 3. A patient who returns after their turn passed is placed just after this
--    token's place in line; rejoin_seq keeps several such patients FIFO.
ALTER TABLE appointments ADD COLUMN queue_after_token INTEGER;
--> statement-breakpoint
ALTER TABLE appointments ADD COLUMN rejoin_seq INTEGER;
--> statement-breakpoint

-- 4. Which capacity pool issued the token, recorded once and never changed.
--    Null for tokens issued without a quota (every token before this migration).
ALTER TABLE appointments ADD COLUMN quota_pool TEXT
  CHECK (quota_pool IN ('reserved', 'shared', 'extra'));
--> statement-breakpoint

-- Backstop for the lock-based allocation: no two patients share a priority place.
CREATE UNIQUE INDEX appointments_priority_seq_key
  ON appointments (doctor_id, service_date, priority_seq)
  WHERE priority_seq IS NOT NULL;
--> statement-breakpoint

ALTER TABLE hospitals ADD COLUMN late_rejoin_after_patients SMALLINT NOT NULL DEFAULT 2
  CHECK (late_rejoin_after_patients >= 0);
--> statement-breakpoint

-- Per-doctor quota configuration. A null quota keeps today's behaviour exactly.
-- There is deliberately no check against the subscription's daily capacity:
-- hospitals are on trial and must be able to configure above it.
ALTER TABLE doctors ADD COLUMN daily_token_quota INTEGER CHECK (daily_token_quota > 0);
--> statement-breakpoint
ALTER TABLE doctors ADD COLUMN walk_in_reserved INTEGER NOT NULL DEFAULT 0
  CHECK (walk_in_reserved >= 0);
--> statement-breakpoint
ALTER TABLE doctors ADD COLUMN online_opens_minutes_before INTEGER NOT NULL DEFAULT 120
  CHECK (online_opens_minutes_before BETWEEN 0 AND 720);
--> statement-breakpoint
ALTER TABLE doctors ADD COLUMN walk_in_release_minutes INTEGER
  CHECK (walk_in_release_minutes BETWEEN 0 AND 720);
--> statement-breakpoint
ALTER TABLE doctors ADD CONSTRAINT doctors_walk_in_within_quota
  CHECK (daily_token_quota IS NULL OR walk_in_reserved <= daily_token_quota);
--> statement-breakpoint

-- Doctor-day state: a counter for priority/rejoin order, and a snapshot of the
-- quota taken when the day's first token is issued, so editing the doctor's
-- settings mid-day never reshuffles a day already in progress.
ALTER TABLE doctor_day_states ADD COLUMN last_queue_seq INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN token_quota INTEGER;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN walk_in_reserved INTEGER;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN walk_in_release_minutes INTEGER;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN online_opens_minutes_before INTEGER;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN last_reserved_token INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN reserved_released_at TIMESTAMPTZ;
--> statement-breakpoint

-- Backfill: desk walk-ins were physically present when created — historically
-- true, and it keeps an in-flight queue callable across the deploy. Remote
-- bookings are left unconfirmed; deploy outside OPD hours.
UPDATE appointments
SET arrived_at = coalesce(enqueued_at, created_at)
WHERE source IN ('walk_in', 'reception') AND arrived_at IS NULL;
--> statement-breakpoint

-- Live priority rows get a sequence in the order they were enqueued, which is
-- the order they were being served in, and the day counter is moved past them.
WITH ranked AS (
  SELECT id, doctor_id, service_date,
         row_number() OVER (PARTITION BY doctor_id, service_date ORDER BY enqueued_at, token_number) AS seq
  FROM appointments
  WHERE priority > 0
    AND status NOT IN ('COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED')
)
UPDATE appointments a SET priority_seq = ranked.seq FROM ranked WHERE a.id = ranked.id;
--> statement-breakpoint
UPDATE doctor_day_states d
SET last_queue_seq = s.max_seq
FROM (
  SELECT doctor_id, service_date, max(priority_seq) AS max_seq
  FROM appointments WHERE priority_seq IS NOT NULL GROUP BY doctor_id, service_date
) s
WHERE d.doctor_id = s.doctor_id AND d.service_date = s.service_date;
