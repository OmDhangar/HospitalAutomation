-- 0051_allergy_medrec.sql — IPD sheets plan, phase B2: allergies and medication reconciliation (§8).
--
-- patient_allergies        what the patient reacts to, kept per patient (not per stay), so it follows
--                          them into every admission and visit. Struck out, never edited.
-- patient_allergy_reviews  someone asked: "no known drug allergies", allergies recorded, or could not
--                          ask (unconscious, no family). The banner says when it was last asked.
-- treatment_orders         + the allergies a medicine line matched when it was written, and the
--                          doctor's reason for going ahead (decision support, never a hard block).
-- med_rec_items            the patient's own medicines at admission, and what is to continue at
--                          discharge, each with the doctor's decision.
-- med_rec_signoffs         a doctor completes a reconciliation (admission or discharge).
--
-- Deposit alerts (B2) read the bill and the payments as they are; their thresholds are the module's
-- settings, so they need no table. All clinical: say what a patient takes or reacts to. Expand-only;
-- written for the runner v2.

CREATE TABLE IF NOT EXISTS patient_allergies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL,
  -- What they react to, as said ("Penicillin", "Sulpha drugs", "Brufen", "Peanuts").
  substance TEXT NOT NULL CHECK (char_length(substance) BETWEEN 2 AND 80),
  category TEXT NOT NULL DEFAULT 'drug' CHECK (category IN ('drug', 'food', 'other')),
  -- When it names a medicine on the hospital's list.
  medicine_id UUID,
  -- The drug class it stands for, from the class map ('penicillins', 'nsaids', …), if any.
  drug_class TEXT CHECK (drug_class IS NULL OR drug_class ~ '^[a-z_]{2,30}$'),
  reaction TEXT CHECK (char_length(reaction) BETWEEN 1 AND 120),
  severity TEXT NOT NULL DEFAULT 'unknown' CHECK (severity IN ('mild', 'moderate', 'severe', 'unknown')),
  source TEXT NOT NULL DEFAULT 'patient' CHECK (source IN ('patient', 'family', 'records', 'observed')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  admission_id UUID,
  client_id UUID NOT NULL,
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT patient_allergies_patient_fk FOREIGN KEY (hospital_id, patient_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT patient_allergies_medicine_fk FOREIGN KEY (hospital_id, medicine_id) REFERENCES medicines (hospital_id, id),
  CONSTRAINT patient_allergies_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS patient_allergies_client_key ON patient_allergies (hospital_id, client_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS patient_allergies_patient_idx ON patient_allergies (patient_id) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS patient_allergy_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id UUID NOT NULL,
  admission_id UUID,
  outcome TEXT NOT NULL CHECK (outcome IN ('nkda', 'recorded', 'unable')),
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 200),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT patient_allergy_reviews_patient_fk FOREIGN KEY (hospital_id, patient_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS patient_allergy_reviews_patient_idx ON patient_allergy_reviews (patient_id, reviewed_at DESC);
--> statement-breakpoint

/* A recorded allergy is struck out (with a reason), never edited or deleted. */
CREATE OR REPLACE FUNCTION public.patient_allergies_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable text[] := ARRAY['voided_at', 'voided_by_user_id', 'void_reason', 'recorded_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An allergy is struck out, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) OR OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'An allergy cannot be edited; strike it out and record it again' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS patient_allergies_guard ON patient_allergies;
--> statement-breakpoint

CREATE TRIGGER patient_allergies_guard BEFORE UPDATE OR DELETE ON patient_allergies
  FOR EACH ROW EXECUTE FUNCTION public.patient_allergies_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS patient_allergy_reviews_append_only ON patient_allergy_reviews;
--> statement-breakpoint

CREATE TRIGGER patient_allergy_reviews_append_only BEFORE UPDATE OR DELETE ON patient_allergy_reviews
  FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
--> statement-breakpoint

/* ------------------------------------------------------------ the check on a medicine line */

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS allergy_matches TEXT[];
--> statement-breakpoint

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS allergy_override_reason TEXT
  CHECK (allergy_override_reason IS NULL OR char_length(allergy_override_reason) BETWEEN 3 AND 200);
--> statement-breakpoint

-- A line that matched an allergy carries the doctor's reason for going ahead.
ALTER TABLE treatment_orders DROP CONSTRAINT IF EXISTS treatment_orders_allergy_override;
--> statement-breakpoint

ALTER TABLE treatment_orders ADD CONSTRAINT treatment_orders_allergy_override
  CHECK (coalesce(cardinality(allergy_matches), 0) = 0 OR allergy_override_reason IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE treatment_orders VALIDATE CONSTRAINT treatment_orders_allergy_override;
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON treatment_orders;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON treatment_orders
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'treatment_order',
    'admission_id,kind,medicine_id,route,ordering_doctor_id,transcribed,countersigned_by_user_id,stopped_at,allergy_matches',
    'entered_by_user_id',
    'ordered_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------------ medication reconciliation */

CREATE TABLE IF NOT EXISTS med_rec_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  -- 'admission': what they were taking at home. 'discharge': what they are to take after going home.
  phase TEXT NOT NULL CHECK (phase IN ('admission', 'discharge')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 120),
  medicine_id UUID,
  dose TEXT CHECK (char_length(dose) BETWEEN 1 AND 40),
  frequency TEXT CHECK (char_length(frequency) BETWEEN 1 AND 40),
  route TEXT CHECK (char_length(route) BETWEEN 1 AND 20),
  -- Discharge: how long ("5 days", "continue", "till review").
  duration TEXT CHECK (char_length(duration) BETWEEN 1 AND 40),
  -- Admission: where it came from. Discharge: the treatment line or home medicine it carries on.
  source TEXT CHECK (source IN ('patient', 'family', 'prescription', 'records', 'treatment_card', 'home', 'new')),
  order_id UUID,
  from_item_id UUID,
  -- Admission: continue / hold / stop / change. Discharge: continue / stop / change / new.
  decision TEXT CHECK (decision IN ('continue', 'hold', 'stop', 'change', 'new')),
  decision_note TEXT CHECK (char_length(decision_note) BETWEEN 1 AND 200),
  decided_at TIMESTAMPTZ,
  decided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT med_rec_items_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT med_rec_items_medicine_fk FOREIGN KEY (hospital_id, medicine_id) REFERENCES medicines (hospital_id, id),
  CONSTRAINT med_rec_items_order_fk FOREIGN KEY (hospital_id, order_id) REFERENCES treatment_orders (hospital_id, id),
  CONSTRAINT med_rec_items_decided CHECK ((decision IS NULL) = (decided_at IS NULL)),
  CONSTRAINT med_rec_items_phase_decision CHECK (
    decision IS NULL
    OR (phase = 'admission' AND decision IN ('continue', 'hold', 'stop', 'change'))
    OR (phase = 'discharge' AND decision IN ('continue', 'stop', 'change', 'new'))
  ),
  CONSTRAINT med_rec_items_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS med_rec_items_tenant_key ON med_rec_items (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS med_rec_items_client_key ON med_rec_items (hospital_id, client_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS med_rec_items_admission_idx ON med_rec_items (admission_id, phase) WHERE voided_at IS NULL;
--> statement-breakpoint

ALTER TABLE med_rec_items DROP CONSTRAINT IF EXISTS med_rec_items_from_item_fk;
--> statement-breakpoint

ALTER TABLE med_rec_items ADD CONSTRAINT med_rec_items_from_item_fk FOREIGN KEY (hospital_id, from_item_id)
  REFERENCES med_rec_items (hospital_id, id);
--> statement-breakpoint

/*
 * An item's medicine, dose and source never change; its decision is made, and may be made again (a
 * doctor changes their mind before the reconciliation is completed), and it is struck out once.
 */
CREATE OR REPLACE FUNCTION public.med_rec_items_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable text[] := ARRAY['decision', 'decision_note', 'decided_at', 'decided_by_user_id',
                          'voided_at', 'voided_by_user_id', 'void_reason', 'recorded_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A medicine on the reconciliation is struck out, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable) OR OLD.voided_at IS NOT NULL THEN
    RAISE EXCEPTION 'This medicine cannot be edited; strike it out and add it again' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS med_rec_items_guard ON med_rec_items;
--> statement-breakpoint

CREATE TRIGGER med_rec_items_guard BEFORE UPDATE OR DELETE ON med_rec_items
  FOR EACH ROW EXECUTE FUNCTION public.med_rec_items_guard();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS med_rec_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('admission', 'discharge')),
  -- Admission: the patient takes nothing at home.
  none_at_home BOOLEAN NOT NULL DEFAULT false,
  items INTEGER NOT NULL CHECK (items >= 0),
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  doctor_id UUID NOT NULL,
  CONSTRAINT med_rec_signoffs_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT med_rec_signoffs_doctor_fk FOREIGN KEY (hospital_id, doctor_id) REFERENCES doctors (hospital_id, id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS med_rec_signoffs_admission_idx ON med_rec_signoffs (admission_id, phase, signed_at DESC);
--> statement-breakpoint

DROP TRIGGER IF EXISTS med_rec_signoffs_append_only ON med_rec_signoffs;
--> statement-breakpoint

CREATE TRIGGER med_rec_signoffs_append_only BEFORE UPDATE OR DELETE ON med_rec_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
--> statement-breakpoint

/* ------------------------------------------------------------ evidence */

DROP TRIGGER IF EXISTS acct_capture ON patient_allergies;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON patient_allergies
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'patient_allergy', 'patient_id,admission_id,category,medicine_id,drug_class,severity,source', 'recorded_by_user_id', 'recorded_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON patient_allergy_reviews;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON patient_allergy_reviews
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'allergy_review', 'patient_id,admission_id,outcome', 'reviewed_by_user_id', 'reviewed_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON med_rec_items;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON med_rec_items
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'med_rec_item', 'admission_id,phase,medicine_id,source,order_id,decision,decided_by_user_id', 'recorded_by_user_id', 'recorded_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON med_rec_signoffs;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON med_rec_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'med_rec_signoff', 'admission_id,phase,none_at_home,items,doctor_id', 'signed_by_user_id', 'signed_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['patient_allergies', 'patient_allergy_reviews', 'med_rec_items', 'med_rec_signoffs'] LOOP
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
    -- What a patient reacts to and takes: clinical (0028).
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON patient_allergies, med_rec_items TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT ON patient_allergy_reviews, med_rec_signoffs TO %I', app);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON patient_allergies, patient_allergy_reviews, med_rec_items, med_rec_signoffs FROM %I', app);
    EXECUTE format('REVOKE UPDATE ON patient_allergy_reviews, med_rec_signoffs FROM %I', app);
  END IF;
END
$outer$;
