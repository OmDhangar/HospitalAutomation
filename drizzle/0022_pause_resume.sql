-- Pause / resume timestamps on the appointment row.
--
-- HELD already exists as an appointment status, and `hold` / `resume` are
-- already queue actions. These two columns record *when* the pause happened
-- and *when* the system should automatically move the appointment back to
-- WAITING — the state machine does not change.

ALTER TABLE appointments ADD COLUMN paused_at TIMESTAMPTZ;
ALTER TABLE appointments ADD COLUMN resume_at TIMESTAMPTZ;

-- Index for the scheduled-resume sweep: find HELD appointments whose
-- resume_at has arrived, without scanning the whole table.
CREATE INDEX appointments_resume_idx
  ON appointments (resume_at)
  WHERE status = 'HELD' AND resume_at IS NOT NULL;
