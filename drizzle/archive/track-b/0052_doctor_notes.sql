-- 0052_doctor_notes.sql — IPD sheets plan, phase C3: the doctor's case sheet and progress notes.
--
-- ipd_notes  the admission note (one live per stay: the paper case sheet) and progress notes, in the
--            sections the paper uses: Case of, C/O (each complaint with how long), H/O, P/H, O/E
--            (general signs and vitals), S/E (CNS, RS, P/A, CVS), Adv. Written by the doctor who saw
--            the patient (signed), or transcribed by a nurse/RMO and countersigned by that doctor.
--            The O/E vitals are prefilled from a chart reading under 2 hours old; when the doctor
--            changes them (or there is none) the note writes one chart row (source 'doctor_note'),
--            linked here, so the chart and the note never disagree.
--
-- A note is struck out, never edited. Clinical. Expand-only; written for the runner v2.

CREATE TABLE IF NOT EXISTS ipd_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('admission', 'progress')),
  -- When the patient was seen.
  seen_at TIMESTAMPTZ NOT NULL,
  case_of TEXT CHECK (char_length(case_of) BETWEEN 1 AND 300),
  -- [{ "text": "Fever", "duration": "3 days" }, …]
  complaints JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(complaints) = 'array' AND jsonb_array_length(complaints) <= 20),
  history TEXT CHECK (char_length(history) BETWEEN 1 AND 2000),
  past_history TEXT CHECK (char_length(past_history) BETWEEN 1 AND 1000),
  -- General examination: { "pallor": "absent", …, "other": "…" }; the vitals are on the chart row.
  general_exam JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(general_exam) = 'object'),
  vitals JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(vitals) = 'object'),
  -- Systemic examination: { "cns": "…", "rs": "…", "pa": "…", "cvs": "…" }.
  systemic_exam JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(systemic_exam) = 'object'),
  -- Progress notes: what changed today.
  progress TEXT CHECK (char_length(progress) BETWEEN 1 AND 2000),
  advice TEXT CHECK (char_length(advice) BETWEEN 1 AND 2000),
  seen_by_doctor_id UUID NOT NULL,
  -- The chart reading the vitals are (written by this note, or the recent one it confirmed).
  chart_entry_id UUID,
  chart_observed_at TIMESTAMPTZ,
  written_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  transcribed BOOLEAN NOT NULL,
  countersigned_at TIMESTAMPTZ,
  countersigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT CHECK (char_length(recorded_device_id) <= 64),
  recorded_session_id UUID,
  client_id UUID NOT NULL,
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT ipd_notes_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT ipd_notes_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT ipd_notes_doctor_fk FOREIGN KEY (hospital_id, seen_by_doctor_id) REFERENCES doctors (hospital_id, id),
  CONSTRAINT ipd_notes_chart_fk FOREIGN KEY (chart_entry_id, chart_observed_at) REFERENCES chart_entries (id, observed_at),
  CONSTRAINT ipd_notes_chart_pair CHECK ((chart_entry_id IS NULL) = (chart_observed_at IS NULL)),
  -- Something must be written: an admission note needs what the patient came with; a progress note,
  -- what changed or what to do.
  CONSTRAINT ipd_notes_content CHECK (
    (kind = 'admission' AND (case_of IS NOT NULL OR jsonb_array_length(complaints) > 0))
    OR (kind = 'progress' AND (progress IS NOT NULL OR advice IS NOT NULL))
  ),
  CONSTRAINT ipd_notes_countersign CHECK (countersigned_at IS NULL OR transcribed),
  CONSTRAINT ipd_notes_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT ipd_notes_not_future CHECK (seen_at <= recorded_at + interval '5 minutes')
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS ipd_notes_tenant_key ON ipd_notes (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS ipd_notes_client_key ON ipd_notes (hospital_id, client_id);
--> statement-breakpoint

-- One live case sheet per stay: to correct it, strike it out and write it again.
CREATE UNIQUE INDEX IF NOT EXISTS ipd_notes_one_admission_note ON ipd_notes (admission_id)
  WHERE kind = 'admission' AND voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ipd_notes_admission_idx ON ipd_notes (admission_id, seen_at) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS ipd_notes_to_countersign_idx ON ipd_notes (seen_by_doctor_id)
  WHERE transcribed AND countersigned_at IS NULL AND voided_at IS NULL;
--> statement-breakpoint

/* A note is countersigned once and struck out once; what was written never changes. */
CREATE OR REPLACE FUNCTION public.ipd_notes_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable text[] := ARRAY['countersigned_at', 'countersigned_by_user_id', 'voided_at', 'voided_by_user_id', 'void_reason', 'written_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A note is struck out, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) THEN
    RAISE EXCEPTION 'A note cannot be edited; strike it out and write it again' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.countersigned_at IS NOT NULL AND NEW.countersigned_at IS DISTINCT FROM OLD.countersigned_at THEN
    RAISE EXCEPTION 'This note is already countersigned' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'This note is already struck out' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS ipd_notes_guard ON ipd_notes;
--> statement-breakpoint

CREATE TRIGGER ipd_notes_guard BEFORE UPDATE OR DELETE ON ipd_notes
  FOR EACH ROW EXECUTE FUNCTION public.ipd_notes_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON ipd_notes;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON ipd_notes
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'ipd_note', 'admission_id,kind,seen_by_doctor_id,transcribed,countersigned_by_user_id,chart_entry_id', 'written_by_user_id', 'seen_at'
  );
--> statement-breakpoint

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
BEGIN
  ALTER TABLE ipd_notes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ipd_notes FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON ipd_notes;
  CREATE POLICY tenant_isolation ON ipd_notes
    USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
    WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
  DROP POLICY IF EXISTS read_only_write ON ipd_notes;
  CREATE POLICY read_only_write ON ipd_notes AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (NOT public.app_read_only());
  DROP POLICY IF EXISTS read_only_delete ON ipd_notes;
  CREATE POLICY read_only_delete ON ipd_notes AS RESTRICTIVE FOR DELETE USING (NOT public.app_read_only());
  DROP POLICY IF EXISTS clinical_access ON ipd_notes;
  CREATE POLICY clinical_access ON ipd_notes AS RESTRICTIVE FOR ALL
    USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access());

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ipd_notes TO %I', app);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON ipd_notes FROM %I', app);
  END IF;
END
$outer$;
