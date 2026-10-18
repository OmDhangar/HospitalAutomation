-- 0048_ipd_phase2_tasks_vitals.sql — IPD Phase 2 Clinical Ledger, Tasks, Draft Rounds & Vitals

CREATE TABLE IF NOT EXISTS clinical_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL,
  record_id TEXT NOT NULL,
  action TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  reason TEXT,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS clinical_audit_logs_hospital_record_idx ON clinical_audit_logs (hospital_id, table_name, record_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ipd_clinical_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'DUE' CHECK (status IN ('DUE', 'OVERDUE', 'GIVEN', 'HELD', 'REFUSED', 'NOT_AVAILABLE', 'MISSED')),
  acted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  acted_at TIMESTAMPTZ,
  dose_given TEXT,
  site TEXT,
  reason TEXT,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_clinical_tasks_adm_idx ON ipd_clinical_tasks (hospital_id, admission_id, scheduled_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_clinical_tasks_order_idx ON ipd_clinical_tasks (hospital_id, order_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS draft_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doctor_id UUID,
  soap_s TEXT,
  soap_o TEXT,
  soap_a TEXT,
  soap_p TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SIGNED')),
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT draft_rounds_user_adm_uq UNIQUE (hospital_id, admission_id, author_user_id)
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vitals_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  temperature_f NUMERIC(4, 1),
  pulse_bpm INTEGER,
  bp_systolic INTEGER,
  bp_diastolic INTEGER,
  respiratory_rate INTEGER,
  spo2_percent INTEGER,
  pain_score INTEGER,
  avpu TEXT CHECK (avpu IN ('A', 'V', 'P', 'U')),
  o2_support TEXT,
  news2_score INTEGER,
  abd_girth_cm NUMERIC(5, 1),
  bsl INTEGER,
  scheduled_slot TEXT,
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS vitals_readings_adm_idx ON vitals_readings (hospital_id, admission_id, recorded_at);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS intake_output (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL CHECK (kind IN ('ORAL', 'IV', 'URINE', 'DRAIN', 'RT_ASPIRATE')),
  ml INTEGER NOT NULL,
  notes TEXT,
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS intake_output_adm_idx ON intake_output (hospital_id, admission_id, recorded_at);

--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinical_audit_logs',
    'ipd_clinical_tasks',
    'draft_rounds',
    'vitals_readings',
    'intake_output'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('DROP POLICY IF EXISTS %I_tenant ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (hospital_id = nullif(current_setting(''app.hospital_id'', true), '''')::uuid)
         WITH CHECK (hospital_id = nullif(current_setting(''app.hospital_id'', true), '''')::uuid)',
      t
    );
    EXECUTE format('DROP POLICY IF EXISTS read_only_write ON %I', t);
    EXECUTE format('CREATE POLICY read_only_write ON %I AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (NOT public.app_read_only())', t);
    EXECUTE format('DROP POLICY IF EXISTS read_only_delete ON %I', t);
    EXECUTE format('CREATE POLICY read_only_delete ON %I AS RESTRICTIVE FOR DELETE USING (NOT public.app_read_only())', t);
  END LOOP;
END $$;

--> statement-breakpoint
DO $$
DECLARE
  app_role text := coalesce(nullif(current_setting('app.db_app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'clinical_audit_logs',
    'ipd_clinical_tasks',
    'draft_rounds',
    'vitals_readings',
    'intake_output'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %I TO %I', t, app_role);
    END IF;
  END LOOP;
END $$;
