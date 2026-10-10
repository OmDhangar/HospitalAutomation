-- 0042_staff_access.sql — IPD sheets plan, phase A5-min (ADR-022): both staff access modes.
--
--   Mode A, shared ward device: a tablet is enrolled once with a one-time code the owner creates;
--   it then stays enrolled (it is never signed out for being unused). Each person unlocks it with
--   their own 4-digit PIN. A PIN session belongs to the person, never the device.
--
--   Mode B, personal device: the normal login, with a lock held on the server (sessions.locked_at)
--   for clinical roles after 15 minutes idle or 5 minutes in the background.
--
--   1. ward_devices: one row per enrolled (or pending) tablet; the device cookie and the enrolment
--      code are stored only as hashes. Twenty wrong PINs in an hour lock the device.
--   2. staff_pins: one PIN per person per hospital (scrypt); five wrong tries lock that person's
--      PIN on every device for fifteen minutes.
--   3. sessions: channel, device, the ward device, last seen and the lock.
--   4. care_entries: the channel and device each bedside entry was recorded from.
--   5. resolve_ward_enrolment(): the one lookup made before any hospital is known — a tablet typing
--      its enrolment code. Returns a hospital id and nothing else (the 0002 pattern).
--   6. Validates the record_access_logs action CHECK added NOT VALID in 0041.
--
-- Written for the runner v2 (ADR-025): idempotent, expand-only.

CREATE TABLE IF NOT EXISTS ward_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- Empty: every ward of the branch.
  ward_ids UUID[] NOT NULL DEFAULT '{}',
  -- SHA-256 of the one-time code typed on the tablet; cleared once used.
  enrol_code_hash TEXT,
  enrol_expires_at TIMESTAMPTZ,
  -- SHA-256 of the long-lived device cookie; set when the tablet enrols.
  token_hash TEXT UNIQUE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  enrolled_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  revoked_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  failed_pins INTEGER NOT NULL DEFAULT 0 CHECK (failed_pins >= 0),
  failed_window_started_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  CONSTRAINT ward_devices_branch_fk FOREIGN KEY (hospital_id, branch_id)
    REFERENCES branches (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT ward_devices_enrolled CHECK ((token_hash IS NULL) = (enrolled_at IS NULL)),
  CONSTRAINT ward_devices_pending_code CHECK (enrolled_at IS NOT NULL OR revoked_at IS NOT NULL OR enrol_code_hash IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS ward_devices_tenant_key ON ward_devices (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS ward_devices_enrol_code_key
  ON ward_devices (enrol_code_hash) WHERE enrol_code_hash IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS staff_pins (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL,
  failed_count INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
  locked_until TIMESTAMPTZ,
  set_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, user_id)
);
--> statement-breakpoint

-- sessions stays outside row-level security (0001): a login is resolved before any hospital is known.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS channel TEXT NOT NULL DEFAULT 'personal'
    CHECK (channel IN ('personal', 'ward_device')),
  ADD COLUMN IF NOT EXISTS ward_device_id UUID REFERENCES ward_devices(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS device_id TEXT CHECK (device_id IS NULL OR char_length(device_id) <= 64),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS sessions_ward_device_idx ON sessions (ward_device_id) WHERE ward_device_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE care_entries
  ADD COLUMN IF NOT EXISTS recorded_channel TEXT
    CHECK (recorded_channel IS NULL OR recorded_channel IN ('personal', 'ward_device')),
  ADD COLUMN IF NOT EXISTS recorded_device_id TEXT
    CHECK (recorded_device_id IS NULL OR char_length(recorded_device_id) <= 64);
--> statement-breakpoint

-- A pending enrolment, by the hash of the code the tablet typed: the hospital it belongs to, or null.
CREATE OR REPLACE FUNCTION public.resolve_ward_enrolment(p_code_hash text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT hospital_id FROM ward_devices
  WHERE enrol_code_hash = p_code_hash
    AND enrolled_at IS NULL
    AND revoked_at IS NULL
    AND enrol_expires_at > now()
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.resolve_ward_enrolment(text) FROM PUBLIC;
--> statement-breakpoint

-- Granted here by name, as 0039 does: the runners pass the app role as qurio.app_role.
DO $app$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.resolve_ward_enrolment(text) TO %I', app);
  END IF;
END
$app$;
--> statement-breakpoint

ALTER TABLE record_access_logs VALIDATE CONSTRAINT record_access_logs_action_check;
--> statement-breakpoint

/* ---------------------------------------------------------------- tenancy */

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ward_devices', 'staff_pins']
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
