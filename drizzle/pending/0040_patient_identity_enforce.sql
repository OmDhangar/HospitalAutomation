-- 0040_patient_identity_enforce.sql — make patient identity required (identity plan, section 6).
--
-- NOT YET IN drizzle/meta/_journal.json, deliberately. The order is:
--   1. 0039 and the code that writes identity on every new patient are deployed;
--   2. npx tsx scripts/backfill-patient-identity.ts reports "0040 can be applied";
--   3. this file moves to drizzle/0040_patient_identity_enforce.sql with a journal entry, and deploys.
-- Applied any earlier, old code still running during the deploy would insert patients without
-- an identity and fail. The precondition below refuses to run on a database that is not ready.
--
-- This is the point of no return for the old (hospital, phone, exact name) patient key.

DO $pre$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM patients WHERE person_id IS NULL OR qid IS NULL OR mrn IS NULL;
  IF n > 0 THEN
    RAISE EXCEPTION '0040: % patient rows have no identity yet; run scripts/backfill-patient-identity.ts first', n;
  END IF;
END $pre$;
--> statement-breakpoint

-- Rows not written since 0039 can still lack the derived key; touching name re-derives it (trigger).
UPDATE patients SET name = name WHERE name_key IS NULL;
--> statement-breakpoint

ALTER TABLE patients
  ALTER COLUMN person_id SET NOT NULL,
  ALTER COLUMN qid SET NOT NULL,
  ALTER COLUMN mrn SET NOT NULL,
  ALTER COLUMN name_key SET NOT NULL;
--> statement-breakpoint

-- One ACTIVE record per person and per QID in a hospital; HOSPITAL-MERGED rows keep theirs.
CREATE UNIQUE INDEX patients_active_person_key ON patients (hospital_id, person_id) WHERE merged_into_id IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX patients_active_qid_key ON patients (hospital_id, qid) WHERE merged_into_id IS NULL;
--> statement-breakpoint
-- An MRN is unique in its hospital across every row ever issued, merged or not.
CREATE UNIQUE INDEX patients_mrn_key ON patients (hospital_id, mrn);
--> statement-breakpoint
DROP INDEX patients_mrn_idx;
--> statement-breakpoint

-- Phone + name is no longer an identity. patients_hospital_phone_idx stays for lookups by phone.
DROP INDEX patients_hospital_phone_name_key;
--> statement-breakpoint

-- "Not the same person": a pair the duplicate finder should stop suggesting.
CREATE TABLE patient_duplicate_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_a_id uuid NOT NULL,
  patient_b_id uuid NOT NULL,
  dismissed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (patient_a_id < patient_b_id),
  FOREIGN KEY (hospital_id, patient_a_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id, patient_b_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX patient_duplicate_dismissals_pair_key
  ON patient_duplicate_dismissals (hospital_id, patient_a_id, patient_b_id);
--> statement-breakpoint
ALTER TABLE patient_duplicate_dismissals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE patient_duplicate_dismissals FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON patient_duplicate_dismissals
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
--> statement-breakpoint
CREATE POLICY read_only_insert ON patient_duplicate_dismissals AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.app_read_only());
--> statement-breakpoint
CREATE POLICY read_only_update ON patient_duplicate_dismissals AS RESTRICTIVE FOR UPDATE
  USING (NOT public.app_read_only()) WITH CHECK (NOT public.app_read_only());
--> statement-breakpoint
CREATE POLICY read_only_delete ON patient_duplicate_dismissals AS RESTRICTIVE FOR DELETE
  USING (NOT public.app_read_only());
--> statement-breakpoint

-- The application role's name is configurable; scripts/migrate.ts passes it as qurio.app_role.
DO $app$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    RAISE EXCEPTION 'application role % does not exist; run npm run db:bootstrap first', app;
  END IF;
  EXECUTE format('GRANT SELECT, INSERT, DELETE ON patient_duplicate_dismissals TO %I', app);
END $app$;
