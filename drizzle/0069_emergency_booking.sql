ALTER TABLE appointments ADD COLUMN IF NOT EXISTS emergency_reason text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS emergency_notes text;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS emergency_handled_at timestamp with time zone;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS emergency_handled_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS appointments_emergency_idx ON appointments (hospital_id, service_date, is_emergency) WHERE is_emergency = true;
