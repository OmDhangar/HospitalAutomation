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
ALTER TABLE clinical_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinical_audit_logs FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'clinical_audit_logs' AND policyname = 'clinical_audit_logs_tenant'
  ) THEN
    CREATE POLICY clinical_audit_logs_tenant ON clinical_audit_logs
      USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
  END IF;
END $$;

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
ALTER TABLE ipd_clinical_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ipd_clinical_tasks FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'ipd_clinical_tasks' AND policyname = 'ipd_clinical_tasks_tenant'
  ) THEN
    CREATE POLICY ipd_clinical_tasks_tenant ON ipd_clinical_tasks
      USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
  END IF;
END $$;

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
ALTER TABLE draft_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE draft_rounds FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'draft_rounds' AND policyname = 'draft_rounds_tenant'
  ) THEN
    CREATE POLICY draft_rounds_tenant ON draft_rounds
      USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
  END IF;
END $$;

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
ALTER TABLE vitals_readings ENABLE ROW LEVEL SECURITY;
ALTER TABLE vitals_readings FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vitals_readings' AND policyname = 'vitals_readings_tenant'
  ) THEN
    CREATE POLICY vitals_readings_tenant ON vitals_readings
      USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
  END IF;
END $$;

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
ALTER TABLE intake_output ENABLE ROW LEVEL SECURITY;
ALTER TABLE intake_output FORCE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'intake_output' AND policyname = 'intake_output_tenant'
  ) THEN
    CREATE POLICY intake_output_tenant ON intake_output
      USING (hospital_id = current_setting('app.current_hospital_id', true)::uuid);
  END IF;
END $$;
