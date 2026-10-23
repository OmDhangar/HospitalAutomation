CREATE TABLE IF NOT EXISTS blackout_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  reopen_date DATE NOT NULL,
  reason TEXT NOT NULL,
  public_reason TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT blackout_date_range_valid CHECK (end_date >= start_date),
  CONSTRAINT blackout_reopen_date_valid CHECK (reopen_date > end_date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS blackout_periods_lookup_idx
  ON blackout_periods (hospital_id, branch_id, doctor_id, start_date, end_date)
  WHERE cancelled_at IS NULL;
--> statement-breakpoint
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'blackout_periods'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$
        DROP POLICY IF EXISTS tenant_isolation ON %I;
        CREATE POLICY tenant_isolation ON %I
          USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
          WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
      $p$,
      t, t
    );
    EXECUTE format(
      $p$
        DROP POLICY IF EXISTS read_only_write ON %I;
        CREATE POLICY read_only_write ON %I AS RESTRICTIVE
          FOR ALL
          USING (true)
          WITH CHECK (NOT public.app_read_only())
      $p$,
      t, t
    );
    EXECUTE format(
      $p$
        DROP POLICY IF EXISTS read_only_delete ON %I;
        CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
          FOR DELETE
          USING (NOT public.app_read_only())
      $p$,
      t, t
    );
  END LOOP;
END
$outer$;
