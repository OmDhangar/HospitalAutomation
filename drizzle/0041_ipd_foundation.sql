-- 0041_ipd_foundation.sql — IPD sheets plan, phase A4-min (ADR-021).
--
--   1. hospital_features: each module's state per hospital (on / read_only / off), the wards it is
--      rolled out to, its stage (observe / warn / enforce) and its settings. A missing row means the
--      module's default from lib/modules/registry.ts.
--   2. Text letterhead: the hospital's registration number and phones; each doctor's qualification,
--      registration number and whether they appear on printed forms. The address is the branch's.
--   3. admissions.ipd_number: the IPD No. printed on every sheet, from document_sequences
--      ('ipd_number'), never reused.
--   4. record_access_logs: device and session columns (filled from phase A5), and three new actions.
--   5. policy_acknowledgements: a staff member accepted a policy (the monitoring notice, A5).
--
-- Written for the runner v2 (ADR-025): idempotent, expand-only, safe to run twice.
-- The new action CHECK is NOT VALID; a later migration validates it without blocking writes.

CREATE TABLE IF NOT EXISTS hospital_features (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK (module_id ~ '^[a-z][a-z0-9_]{1,39}$'),
  state TEXT NOT NULL CHECK (state IN ('on', 'read_only', 'off')),
  -- {"all": true}, or {"all": false, "wardIds": [...]} for a ward-by-ward rollout.
  rollout_scope JSONB NOT NULL DEFAULT '{"all": true}'::jsonb
    CHECK (jsonb_typeof(rollout_scope) = 'object' AND octet_length(rollout_scope::text) < 8000),
  stage TEXT NOT NULL DEFAULT 'observe' CHECK (stage IN ('observe', 'warn', 'enforce')),
  settings JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings) = 'object' AND octet_length(settings::text) < 8000),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, module_id)
);
--> statement-breakpoint

ALTER TABLE hospitals
  ADD COLUMN IF NOT EXISTS registration_no TEXT
    CHECK (registration_no IS NULL OR char_length(registration_no) BETWEEN 1 AND 60),
  ADD COLUMN IF NOT EXISTS letterhead_phones TEXT
    CHECK (letterhead_phones IS NULL OR char_length(letterhead_phones) BETWEEN 1 AND 120);
--> statement-breakpoint

ALTER TABLE doctors
  ADD COLUMN IF NOT EXISTS qualification TEXT
    CHECK (qualification IS NULL OR char_length(qualification) BETWEEN 1 AND 80),
  ADD COLUMN IF NOT EXISTS registration_no TEXT
    CHECK (registration_no IS NULL OR char_length(registration_no) BETWEEN 1 AND 40),
  ADD COLUMN IF NOT EXISTS on_letterhead BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint

ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS ipd_number INTEGER CHECK (ipd_number IS NULL OR ipd_number > 0);
--> statement-breakpoint

-- admissions is small (one row per stay) and the new column is empty, so this scan is short.
CREATE UNIQUE INDEX IF NOT EXISTS admissions_ipd_number_key
  ON admissions (hospital_id, ipd_number) WHERE ipd_number IS NOT NULL;
--> statement-breakpoint

ALTER TABLE record_access_logs
  ADD COLUMN IF NOT EXISTS device_id TEXT CHECK (device_id IS NULL OR char_length(device_id) <= 64),
  -- No foreign key: a session row is deleted at logout, and the log must outlive it.
  ADD COLUMN IF NOT EXISTS session_id UUID;
--> statement-breakpoint

ALTER TABLE record_access_logs DROP CONSTRAINT IF EXISTS record_access_logs_action_check;
--> statement-breakpoint

ALTER TABLE record_access_logs ADD CONSTRAINT record_access_logs_action_check
  CHECK (action IN (
    'view_history', 'print_prescription', 'view_admission', 'print_ipd_bill',
    'print_ipd_file', 'view_file_upload', 'family_unlock'
  )) NOT VALID;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS policy_acknowledgements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  -- CASCADE: erasing a staff account (DPDP) erases its acknowledgements with it.
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_key TEXT NOT NULL CHECK (policy_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 20),
  locale TEXT NOT NULL CHECK (locale IN ('en', 'mr', 'hi')),
  channel TEXT CHECK (channel IS NULL OR channel IN ('ward_device', 'personal')),
  device_id TEXT CHECK (device_id IS NULL OR char_length(device_id) <= 64),
  acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS policy_acknowledgements_once
  ON policy_acknowledgements (hospital_id, user_id, policy_key, policy_version);
--> statement-breakpoint

-- What someone accepted, and when, is evidence: it is never rewritten.
DROP TRIGGER IF EXISTS policy_acknowledgements_append_only ON policy_acknowledgements;
--> statement-breakpoint

CREATE TRIGGER policy_acknowledgements_append_only
  BEFORE UPDATE ON policy_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION reject_history_update();
--> statement-breakpoint

/* ---------------------------------------------------------------- tenancy */

-- The 0032 block, made re-runnable: each policy is dropped before it is created.
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['hospital_features', 'policy_acknowledgements']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($p$
        CREATE POLICY tenant_isolation ON %I
          USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
          WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
      $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS read_only_write ON %I', t);
    EXECUTE format($p$
        CREATE POLICY read_only_write ON %I AS RESTRICTIVE
          FOR ALL USING (true) WITH CHECK (NOT public.app_read_only())
      $p$, t);

    EXECUTE format('DROP POLICY IF EXISTS read_only_delete ON %I', t);
    EXECUTE format($p$
        CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
          FOR DELETE USING (NOT public.app_read_only())
      $p$, t);
  END LOOP;
END
$outer$;
