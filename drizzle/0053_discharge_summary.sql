-- 0053_discharge_summary.sql — IPD sheets plan, phase B5: the discharge summary.
--
-- discharge_summary_drafts  the summary being written: one per stay, freely edited, OUTSIDE the
--                           record (it is a working copy; nothing reads it as the patient's summary).
-- discharge_summaries       the record: each finalised version, numbered, never edited. A version
--                           finalised from the responsible doctor's own login is signed; one finalised
--                           by anyone else waits for that doctor's countersign. A later version
--                           supersedes the earlier one (supersedes_id). Only a signed version prints
--                           without "DRAFT" and may be shared.
--
-- The draft starts from the record (deterministic, no AI): the admission reason and case sheet, the
-- complaints and findings, the tests ordered, the treatment card, the discharge medicines from the
-- reconciliation; follow-up, diet and warning signs are the doctor's. Clinical. Expand-only; written
-- for the runner v2.

CREATE TABLE IF NOT EXISTS discharge_summary_drafts (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  PRIMARY KEY (hospital_id, admission_id),
  CONSTRAINT discharge_summary_drafts_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS discharge_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  version SMALLINT NOT NULL CHECK (version BETWEEN 1 AND 99),
  supersedes_id UUID,
  content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
  -- The doctor responsible for the summary.
  doctor_id UUID NOT NULL,
  finalised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finalised_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  transcribed BOOLEAN NOT NULL,
  signed_at TIMESTAMPTZ,
  signed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Why a new version was made (required from version 2).
  change_reason TEXT CHECK (char_length(change_reason) BETWEEN 3 AND 200),
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT CHECK (char_length(recorded_device_id) <= 64),
  recorded_session_id UUID,
  client_id UUID NOT NULL,
  CONSTRAINT discharge_summaries_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT discharge_summaries_doctor_fk FOREIGN KEY (hospital_id, doctor_id) REFERENCES doctors (hospital_id, id),
  CONSTRAINT discharge_summaries_versioning CHECK ((version = 1) = (supersedes_id IS NULL) AND (version = 1 OR change_reason IS NOT NULL)),
  -- Signed from the doctor's own login at once, or countersigned later.
  CONSTRAINT discharge_summaries_signed CHECK (transcribed OR signed_at IS NOT NULL),
  CONSTRAINT discharge_summaries_signer CHECK ((signed_at IS NULL) = (signed_by_user_id IS NULL) OR signed_by_user_id IS NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS discharge_summaries_tenant_key ON discharge_summaries (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS discharge_summaries_client_key ON discharge_summaries (hospital_id, client_id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS discharge_summaries_version_key ON discharge_summaries (admission_id, version);
--> statement-breakpoint

-- A version is superseded once.
CREATE UNIQUE INDEX IF NOT EXISTS discharge_summaries_supersedes_key ON discharge_summaries (supersedes_id) WHERE supersedes_id IS NOT NULL;
--> statement-breakpoint

ALTER TABLE discharge_summaries DROP CONSTRAINT IF EXISTS discharge_summaries_supersedes_fk;
--> statement-breakpoint

ALTER TABLE discharge_summaries ADD CONSTRAINT discharge_summaries_supersedes_fk FOREIGN KEY (hospital_id, supersedes_id)
  REFERENCES discharge_summaries (hospital_id, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS discharge_summaries_to_sign_idx ON discharge_summaries (doctor_id) WHERE signed_at IS NULL;
--> statement-breakpoint

/* A finalised version is never edited: only its countersign is written, once. */
CREATE OR REPLACE FUNCTION public.discharge_summaries_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable text[] := ARRAY['signed_at', 'signed_by_user_id', 'finalised_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A discharge summary is never deleted; write a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'A finalised summary cannot be edited; write a new version' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.signed_at IS NOT NULL AND NEW.signed_at IS DISTINCT FROM OLD.signed_at THEN
    RAISE EXCEPTION 'This summary is already signed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS discharge_summaries_guard ON discharge_summaries;
--> statement-breakpoint

CREATE TRIGGER discharge_summaries_guard BEFORE UPDATE OR DELETE ON discharge_summaries
  FOR EACH ROW EXECUTE FUNCTION public.discharge_summaries_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON discharge_summaries;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON discharge_summaries
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'discharge_summary', 'admission_id,version,supersedes_id,doctor_id,transcribed,signed_by_user_id', 'finalised_by_user_id', 'finalised_at'
  );
--> statement-breakpoint

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['discharge_summary_drafts', 'discharge_summaries'] LOOP
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
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON discharge_summary_drafts TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON discharge_summaries TO %I', app);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON discharge_summaries FROM %I', app);
  END IF;
END
$outer$;
