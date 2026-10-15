-- 0049_ipd_lifecycle_and_clinical_gates.sql — IPD Lifecycle, Clinical Gates, Verbal Orders, Measurements, Discharge Summaries & Bed Cleaning

-- 1. Explicit verbal orders state machine on ipd_medication_orders
ALTER TABLE ipd_medication_orders
  ADD COLUMN IF NOT EXISTS is_verbal BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS verbal_order_status TEXT DEFAULT 'none' CHECK (verbal_order_status IN ('none', 'pending_cosign', 'cosigned', 'rejected', 'modified')),
  ADD COLUMN IF NOT EXISTS verbal_doctor_name TEXT,
  ADD COLUMN IF NOT EXISTS verbal_clinical_rationale TEXT,
  ADD COLUMN IF NOT EXISTS cosigned_by_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cosigned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cosign_notes TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_med_orders_verbal_status_idx ON ipd_medication_orders (hospital_id, verbal_order_status);

-- 2. Dedicated Patient Measurements table (timeline for weight, height, BMI)
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS patient_measurements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  weight_kg NUMERIC(5, 2),
  height_cm NUMERIC(5, 1),
  bmi NUMERIC(4, 1),
  notes TEXT,
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS patient_measurements_adm_idx ON patient_measurements (hospital_id, admission_id, recorded_at);

-- 3. Home Medication Reconciliation & Versioned Discharge Summaries
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ipd_admission_home_medications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  frequency TEXT NOT NULL,
  last_taken_at TIMESTAMPTZ,
  reconciliation_status TEXT NOT NULL DEFAULT 'continued' CHECK (reconciliation_status IN ('continued', 'stopped', 'modified')),
  reconciliation_notes TEXT,
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_home_meds_adm_idx ON ipd_admission_home_medications (hospital_id, admission_id);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ipd_discharge_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  discharge_type TEXT NOT NULL DEFAULT 'regular' CHECK (discharge_type IN ('regular', 'lama', 'dama', 'transfer', 'death')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'superseded')),
  primary_diagnosis TEXT,
  secondary_diagnoses TEXT,
  hospital_course TEXT,
  condition_at_discharge TEXT,
  investigation_summary TEXT,
  discharge_advice TEXT,
  diet_advice TEXT,
  urgent_warning_signs TEXT,
  follow_up_date DATE,
  prescriber_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  prescriber_registration_no TEXT,
  finalized_at TIMESTAMPTZ,
  finalized_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_discharge_summaries_adm_ver_idx ON ipd_discharge_summaries (hospital_id, admission_id, version);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS ipd_take_home_prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  discharge_summary_id UUID NOT NULL REFERENCES ipd_discharge_summaries(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  dosage TEXT NOT NULL,
  route TEXT DEFAULT 'oral',
  frequency TEXT NOT NULL,
  duration TEXT,
  instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_take_home_rx_summary_idx ON ipd_take_home_prescriptions (hospital_id, discharge_summary_id);

-- 4. Bed Cleaning Lifecycle and Doctor Vitals Frequency Order
--> statement-breakpoint
ALTER TABLE beds
  ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'vacant' CHECK (status IN ('vacant', 'occupied', 'cleaning', 'maintenance')),
  ADD COLUMN IF NOT EXISTS cleaned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cleaned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS beds_status_idx ON beds (hospital_id, status);

--> statement-breakpoint
ALTER TABLE admissions
  ADD COLUMN IF NOT EXISTS vitals_frequency TEXT DEFAULT 'q4h';

-- 5. Row-Level Security
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'patient_measurements',
    'ipd_admission_home_medications',
    'ipd_discharge_summaries',
    'ipd_take_home_prescriptions'
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
