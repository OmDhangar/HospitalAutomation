-- The day's serving sequence ("call number"), separate from the token.
--
-- A token is the booking's permanent identity and is never renumbered, but it
-- is not the serving order: an arrived later token, a priority patient or an
-- emergency can be seen first. Showing tokens as the queue made a correctly
-- served token 31 look as if it had jumped tokens 29 and 30. The call number
-- is issued 1, 2, 3… as patients are actually called, so the order patients
-- see is always ascending. Additive; nothing existing changes meaning.

ALTER TABLE appointments ADD COLUMN call_number INTEGER;
--> statement-breakpoint
ALTER TABLE doctor_day_states ADD COLUMN last_call_number INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint

-- Backfill: number everyone already called, per doctor-day, in call order, so
-- a day in progress at deploy time continues from the right number.
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY doctor_id, service_date ORDER BY called_at, token_number) AS n
  FROM appointments
  WHERE called_at IS NOT NULL
)
UPDATE appointments a SET call_number = ranked.n FROM ranked WHERE a.id = ranked.id;
--> statement-breakpoint
UPDATE doctor_day_states d
SET last_call_number = s.max_n
FROM (
  SELECT doctor_id, service_date, max(call_number) AS max_n
  FROM appointments WHERE call_number IS NOT NULL GROUP BY doctor_id, service_date
) s
WHERE d.doctor_id = s.doctor_id AND d.service_date = s.service_date;
