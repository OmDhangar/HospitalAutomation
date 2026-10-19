-- 0054_ipd_admission_and_consents.sql — IPD admission redesign, arrival split, clinical alerts, persistent contacts, versioned consents, and MLC tracking.

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS admission_number TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS urgency TEXT DEFAULT 'same_day';
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS advised_ward_kind TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS estimated_stay_days SMALLINT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS reception_notes TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS referring_doctor_name TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS arrival_backdate_reason TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS is_mlc BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_number TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_category TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_narrative TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS police_station_name TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS police_intimated_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS police_intimation_mode TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS constable_name TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS constable_buckle_no TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS mlc_intimation_copy_url TEXT;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS first_reviewed_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS first_reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS is_intake_complete BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS intake_completed_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE admissions ADD COLUMN IF NOT EXISTS intake_completed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS admissions_arrived_idx ON admissions (hospital_id, arrived_at)
  WHERE arrived_at IS NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS patient_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relation TEXT NOT NULL,
  phone_e164 TEXT,
  address TEXT,
  is_emergency_contact BOOLEAN NOT NULL DEFAULT true,
  is_decision_maker BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS patient_contacts_tenant_key ON patient_contacts (hospital_id, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS patient_contacts_patient_idx ON patient_contacts (hospital_id, patient_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS consent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  version SMALLINT NOT NULL DEFAULT 1,
  title_en TEXT NOT NULL,
  title_mr TEXT,
  title_hi TEXT,
  body_en TEXT NOT NULL,
  body_mr TEXT,
  body_hi TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS consent_templates_tenant_key ON consent_templates (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS consent_templates_active_key ON consent_templates (hospital_id, code)
  WHERE is_active = true;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS patient_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  template_id UUID REFERENCES consent_templates(id) ON DELETE SET NULL,
  template_version SMALLINT NOT NULL DEFAULT 1,
  text_snapshot TEXT NOT NULL,
  text_hash_sha256 TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'mr',
  status TEXT NOT NULL DEFAULT 'pending',
  pending_reason TEXT,
  signatory_capacity TEXT NOT NULL DEFAULT 'patient',
  inability_reason TEXT,
  signatory_contact_id UUID REFERENCES patient_contacts(id) ON DELETE SET NULL,
  signatory_name_snapshot TEXT NOT NULL,
  signatory_relation_snapshot TEXT NOT NULL,
  signatory_phone_snapshot TEXT,
  method TEXT NOT NULL DEFAULT 'paper',
  paper_on_file BOOLEAN NOT NULL DEFAULT false,
  paper_document_scan_url TEXT,
  digital_signature_vector TEXT,
  explained_by_doctor_id UUID REFERENCES doctors(id) ON DELETE SET NULL,
  witness_staff_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS patient_consents_tenant_key ON patient_consents (hospital_id, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS patient_consents_admission_idx ON patient_consents (hospital_id, admission_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS clinical_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  type TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_id UUID NOT NULL,
  recipient_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recipient_role TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  escalate_after_minutes SMALLINT NOT NULL DEFAULT 20,
  escalated_at TIMESTAMPTZ,
  escalated_to_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  escalated_to_role TEXT DEFAULT 'nurse',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS clinical_alerts_tenant_key ON clinical_alerts (hospital_id, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS clinical_alerts_recipient_idx ON clinical_alerts (hospital_id, recipient_user_id, status)
  WHERE status IN ('pending', 'escalated');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS clinical_alerts_sweep_idx ON clinical_alerts (hospital_id, status, created_at)
  WHERE status = 'pending';
--> statement-breakpoint

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient_contacts', 'consent_templates', 'patient_consents', 'clinical_alerts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
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

  FOREACH t IN ARRAY ARRAY['patient_consents', 'clinical_alerts'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON patient_contacts TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON consent_templates TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON patient_consents TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON clinical_alerts TO %I', app);
  END IF;
END
$outer$;
