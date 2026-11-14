CREATE TABLE IF NOT EXISTS patient_merge_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL DEFAULT 'critical_patient_merge',
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_role TEXT NOT NULL,
  from_patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  to_patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  from_uhid TEXT,
  to_uhid TEXT,
  from_patient_name TEXT NOT NULL,
  to_patient_name TEXT NOT NULL,
  critical_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  justification TEXT NOT NULL,
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS patient_merge_alerts_tenant_key ON patient_merge_alerts (hospital_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patient_merge_alerts_hospital_created_idx ON patient_merge_alerts (hospital_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patient_merge_alerts_hospital_reviewed_idx ON patient_merge_alerts (hospital_id, reviewed_at);
--> statement-breakpoint
DO $outer$
DECLARE
  t text := 'patient_merge_alerts';
BEGIN
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
END
$outer$;
