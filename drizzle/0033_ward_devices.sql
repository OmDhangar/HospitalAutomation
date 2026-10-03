-- Shared ward devices with nurse PINs (IPD plan §3.3, task T1.9).
--
-- Most wards have one tablet, not a phone per nurse (decision D-DV). The
-- owner registers that tablet once; it then shows "Who is recording?", and a
-- nurse unlocks it with her own 4-digit PIN. The unlock is a short session:
--
--   * it is tied to the device (sessions.ward_device_id), so revoking the
--     device ends every session on it;
--   * it resolves as a nurse whatever the person's real role, so a PIN can
--     only ever record at the bedside;
--   * it ends after 10 minutes idle (the session's expires_at slides).
--
-- A PIN is four digits, so it is only as strong as the lock-out: five wrong
-- tries lock that person on that device for fifteen minutes.

ALTER TABLE staff_memberships ADD COLUMN pin_hash TEXT;
--> statement-breakpoint

CREATE TABLE ward_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  -- SHA-256 of the long-lived device cookie; the cookie itself is never stored.
  token_hash TEXT NOT NULL UNIQUE,
  registered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  registered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  CONSTRAINT ward_devices_branch_fk FOREIGN KEY (hospital_id, branch_id)
    REFERENCES branches (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX ward_devices_tenant_key ON ward_devices (hospital_id, id);
--> statement-breakpoint

-- Failed PIN tries per person per device. Reset on a correct PIN.
CREATE TABLE ward_device_pin_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  device_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  failed_count INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ward_device_pin_attempts_device_fk FOREIGN KEY (hospital_id, device_id)
    REFERENCES ward_devices (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX ward_device_pin_attempts_key ON ward_device_pin_attempts (device_id, user_id);
--> statement-breakpoint

-- Sessions stay outside row-level security (0001: a login is resolved
-- before any hospital is known); this only marks which ones are PIN
-- sessions on a ward device.
ALTER TABLE sessions
  ADD COLUMN ward_device_id UUID REFERENCES ward_devices(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX sessions_ward_device_idx ON sessions (ward_device_id) WHERE ward_device_id IS NOT NULL;
--> statement-breakpoint

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ward_devices', 'ward_device_pin_attempts']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$
        CREATE POLICY tenant_isolation ON %I
          USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
          WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
      $p$,
      t
    );
    EXECUTE format(
      $p$
        CREATE POLICY read_only_write ON %I AS RESTRICTIVE
          FOR ALL
          USING (true)
          WITH CHECK (NOT public.app_read_only())
      $p$,
      t
    );
    EXECUTE format(
      $p$
        CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
          FOR DELETE
          USING (NOT public.app_read_only())
      $p$,
      t
    );
  END LOOP;
END
$outer$;
