ALTER TABLE doctor_day_states
  ADD COLUMN IF NOT EXISTS opd_stopped_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE doctor_day_states
  ADD COLUMN IF NOT EXISTS opd_stopped_by_user_id UUID
  REFERENCES users(id) ON DELETE SET NULL;
