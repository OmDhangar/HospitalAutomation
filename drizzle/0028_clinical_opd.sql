-- OPD clinical records: the medicine catalogue, diagnoses, consultation notes
-- and prescriptions — plus the guard that keeps them away from anyone who has
-- no clinical reason to read them.
--
-- The rules, in the order they matter:
--
--   1. The medicine catalogue is CONFIGURATION: what the hospital offers and
--      at what price. A prescription is a CLINICAL RECORD: what the doctor
--      ordered. They are linked by medicine_id but never merged, and a
--      prescription carries no price at all.
--
--   2. A clinical record is written once, at Save, and never edited. Until
--      Save the doctor's work lives in `consultation_drafts`, which is scratch
--      space and not part of the record. After Save, a correction is a new
--      prescription that supersedes the old one, or a void plus a new row —
--      so a printed prescription can never silently change.
--
--   3. Prescription items copy the medicine's name, strength and form. Renaming
--      a medicine in the catalogue must not change what an old prescription
--      says the doctor prescribed.
--
--   4. Clinical rows need a second key. Row-level security already confines
--      every row to its hospital; the policy added here also requires
--      `app.clinical_access`, which withTenant() sets only when a clinical
--      service asks for it AND the request is not a read-only support session.
--      Reports, exports, the public queue page and support staff therefore see
--      no clinical rows, and the database — not the UI — is what says so.

/* ------------------------------------------------ doctor ↔ login account */

-- A prescription records which doctor wrote it, and only that doctor may write
-- or revise it. The link is doctors.user_id, which existed but was never set;
-- one login may be at most one doctor per hospital, or "which doctor am I?"
-- would have two answers.
CREATE UNIQUE INDEX doctors_hospital_user_key ON doctors (hospital_id, user_id)
  WHERE user_id IS NOT NULL;
--> statement-breakpoint

/* --------------------------------------------------------- clinical key */

-- Fail-closed exactly like app_read_only(): anything unparseable reads as
-- "no clinical access". The nullif() handles the '' a pooled connection
-- returns once any transaction has set the value.
CREATE OR REPLACE FUNCTION public.app_clinical_access()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.clinical_access', true), '')::boolean,
    false
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.app_clinical_access() FROM PUBLIC;
--> statement-breakpoint

/* -------------------------------------------------------------- enums */

CREATE TYPE clinical_note_kind AS ENUM ('consultation');
--> statement-breakpoint
-- 'final' is the only state a prescription is born in; 'superseded' is the
-- only change it can undergo. There is no draft state here on purpose: drafts
-- live in consultation_drafts, outside the record.
CREATE TYPE prescription_status AS ENUM ('final', 'superseded');
--> statement-breakpoint

/* ---------------------------------------------------------- medicines */

CREATE TABLE medicines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  -- As the doctor knows it: a brand ("Dolo") or a generic ("Paracetamol").
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  generic_name TEXT CHECK (generic_name IS NULL OR char_length(generic_name) <= 120),
  strength TEXT CHECK (strength IS NULL OR char_length(strength) <= 40),
  form TEXT CHECK (form IS NULL OR char_length(form) <= 40),
  -- The BILLING unit — what one unit of quantity on a bill means.
  unit TEXT NOT NULL DEFAULT 'unit' CHECK (char_length(unit) BETWEEN 1 AND 20),
  -- The hospital's selling price per unit. Not "price" and not MRP, so a
  -- pharmacy module can add those beside it without changing this meaning.
  -- Null = not priced yet: prescribable, but refused on a bill.
  selling_price_paise INTEGER CHECK (selling_price_paise >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX medicines_tenant_key ON medicines (hospital_id, id);
--> statement-breakpoint
-- Identity is name + strength + form: "Paracetamol 500 mg tablet" and
-- "Paracetamol syrup" are different products.
CREATE UNIQUE INDEX medicines_identity_key ON medicines (
  hospital_id, lower(name), coalesce(lower(strength), ''), coalesce(lower(form), '')
);
--> statement-breakpoint
-- Typeahead: prefix match on either name, active medicines only.
CREATE INDEX medicines_name_search_idx ON medicines (hospital_id, lower(name) text_pattern_ops)
  WHERE active;
--> statement-breakpoint
CREATE INDEX medicines_generic_search_idx
  ON medicines (hospital_id, lower(generic_name) text_pattern_ops)
  WHERE active AND generic_name IS NOT NULL;
--> statement-breakpoint

/* ------------------------------------------------ consultation drafts */

-- What the doctor has typed but not yet saved. Mutable, one per encounter,
-- deleted at Save. Kept server-side rather than in the browser so a shared
-- desk computer never holds a patient's notes after the tab is closed, and so
-- the doctor can move from laptop to tablet mid-consultation.
CREATE TABLE consultation_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  payload JSONB NOT NULL,
  -- Bumped on every save; a stale write from a second screen is refused
  -- rather than silently overwriting the newer text.
  version INTEGER NOT NULL DEFAULT 1,
  updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT consultation_drafts_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX consultation_drafts_encounter_key ON consultation_drafts (encounter_id);
--> statement-breakpoint

/* ---------------------------------------------------------- diagnoses */

-- Free text for now. `code` exists so ICD-10 can be added later without a
-- new table. Kept apart from prescriptions: what the doctor concluded and
-- what the doctor ordered are different facts about the same visit.
CREATE TABLE diagnoses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  doctor_id UUID NOT NULL REFERENCES doctors(id),
  text TEXT NOT NULL CHECK (char_length(text) BETWEEN 1 AND 300),
  code TEXT,
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT diagnoses_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE,
  CONSTRAINT diagnoses_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint
CREATE INDEX diagnoses_encounter_idx ON diagnoses (encounter_id) WHERE voided_at IS NULL;
--> statement-breakpoint

/* ------------------------------------------------------ clinical notes */

-- Free-text clinical writing. Only consultation notes today; IPD progress and
-- admission notes are further values of `kind`, added when those screens are.
CREATE TABLE clinical_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  kind clinical_note_kind NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  author_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  doctor_id UUID REFERENCES doctors(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT clinical_notes_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE,
  CONSTRAINT clinical_notes_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint
CREATE INDEX clinical_notes_encounter_idx ON clinical_notes (encounter_id) WHERE voided_at IS NULL;
--> statement-breakpoint

/* ------------------------------------------------------- prescriptions */

-- The doctor's instruction to the patient. Carries no price and never
-- creates a bill: a doctor may prescribe what the patient buys elsewhere.
CREATE TABLE prescriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  prescriber_doctor_id UUID NOT NULL REFERENCES doctors(id),
  -- What the printed slip says, even if the doctor's name is later edited.
  prescriber_name TEXT NOT NULL,
  status prescription_status NOT NULL DEFAULT 'final',
  advice TEXT CHECK (advice IS NULL OR char_length(advice) <= 1000),
  follow_up_on DATE,
  supersedes_prescription_id UUID REFERENCES prescriptions(id),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT prescriptions_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX prescriptions_tenant_key ON prescriptions (hospital_id, id);
--> statement-breakpoint
-- The current prescription of a visit is the one that is still 'final'.
CREATE UNIQUE INDEX prescriptions_one_current_key ON prescriptions (encounter_id)
  WHERE status = 'final';
--> statement-breakpoint
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at)
  WHERE status = 'final';
--> statement-breakpoint
CREATE INDEX prescriptions_doctor_idx ON prescriptions (prescriber_doctor_id, created_at);
--> statement-breakpoint

CREATE TABLE prescription_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  prescription_id UUID NOT NULL,
  -- The canonical identity. NO ACTION: a referenced medicine is deactivated,
  -- never deleted, so this row can always be traced to it.
  medicine_id UUID NOT NULL,
  -- What the doctor saw and what was printed. Rename-proof.
  medicine_name TEXT NOT NULL,
  strength TEXT,
  form TEXT,
  dose TEXT NOT NULL CHECK (char_length(dose) BETWEEN 1 AND 60),
  -- Indian notation ("1-0-1", "SOS"), offered as presets in the UI.
  frequency TEXT NOT NULL CHECK (char_length(frequency) BETWEEN 1 AND 40),
  duration_days SMALLINT CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  route TEXT CHECK (route IS NULL OR char_length(route) <= 40),
  instructions TEXT CHECK (instructions IS NULL OR char_length(instructions) <= 200),
  sort_order SMALLINT NOT NULL,
  -- No quantity, deliberately: what is prescribed is not what is dispensed or
  -- billed. A future dispensing table points here without changing it.
  CONSTRAINT prescription_items_prescription_fk FOREIGN KEY (hospital_id, prescription_id)
    REFERENCES prescriptions (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT prescription_items_medicine_fk FOREIGN KEY (hospital_id, medicine_id)
    REFERENCES medicines (hospital_id, id)
);
--> statement-breakpoint
CREATE INDEX prescription_items_prescription_idx ON prescription_items (prescription_id, sort_order);
--> statement-breakpoint
CREATE INDEX prescription_items_medicine_idx ON prescription_items (medicine_id);
--> statement-breakpoint

/* ------------------------------------------------------- access log */

-- Who opened whose medical history, and who printed what. Append-only.
-- Not a clinical table itself: it names a patient but holds no clinical
-- content, and the owner must be able to read it to answer "who looked?".
CREATE TABLE record_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  encounter_id UUID REFERENCES encounters(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('view_history', 'print_prescription')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX record_access_logs_patient_idx ON record_access_logs (patient_id, created_at);
--> statement-breakpoint
CREATE INDEX record_access_logs_hospital_idx ON record_access_logs (hospital_id, created_at);
--> statement-breakpoint
CREATE TRIGGER record_access_logs_append_only
  BEFORE UPDATE ON record_access_logs
  FOR EACH ROW EXECUTE FUNCTION reject_history_update();
--> statement-breakpoint

/* ------------------------------------------------------------ integrity */

-- Shared by every void-able clinical table: the only changes allowed are a
-- one-way void, or ON DELETE SET NULL clearing a removed staff account.
-- The trigger's arguments name the user-reference columns of its table.
CREATE OR REPLACE FUNCTION void_only_guard() RETURNS trigger AS $fn$
BEGIN
  IF only_user_refs_cleared(to_jsonb(OLD), to_jsonb(NEW), TG_ARGV)
     OR is_one_way_void(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% may only be voided, never edited', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER diagnoses_void_only
  BEFORE UPDATE ON diagnoses
  FOR EACH ROW EXECUTE FUNCTION void_only_guard('recorded_by_user_id', 'voided_by_user_id');
--> statement-breakpoint
CREATE TRIGGER clinical_notes_void_only
  BEFORE UPDATE ON clinical_notes
  FOR EACH ROW EXECUTE FUNCTION void_only_guard('author_user_id', 'voided_by_user_id');
--> statement-breakpoint

-- A saved prescription may only become 'superseded' — by a revision — and
-- nothing else about it may change.
CREATE OR REPLACE FUNCTION prescriptions_guard() RETURNS trigger AS $fn$
BEGIN
  IF only_user_refs_cleared(to_jsonb(OLD), to_jsonb(NEW), ARRAY['created_by_user_id']) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'final'
     AND NEW.status = 'superseded'
     AND (to_jsonb(OLD) - 'status') = (to_jsonb(NEW) - 'status') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'prescription % is saved and cannot be changed; revise it instead', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prescriptions_guard
  BEFORE UPDATE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION prescriptions_guard();
--> statement-breakpoint

-- Items are written in the same transaction as their prescription, and never
-- again. now() is the start time of the current transaction, and a
-- prescription's created_at defaults to now() — so the two are equal only
-- inside the transaction that created it. Once that transaction commits, no
-- item can be added to, changed in, or moved between saved prescriptions.
CREATE OR REPLACE FUNCTION prescription_items_guard() RETURNS trigger AS $fn$
DECLARE
  created TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'prescription items cannot be edited; revise the prescription instead'
      USING ERRCODE = 'restrict_violation';
  END IF;

  SELECT created_at INTO created FROM prescriptions WHERE id = NEW.prescription_id;
  IF created IS DISTINCT FROM now() THEN
    RAISE EXCEPTION 'prescription % is already saved; revise it instead', NEW.prescription_id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER prescription_items_guard
  BEFORE INSERT OR UPDATE ON prescription_items
  FOR EACH ROW EXECUTE FUNCTION prescription_items_guard();
--> statement-breakpoint

/* --------------------------------------------------------------- tenancy */

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'medicines',
    'consultation_drafts',
    'diagnoses',
    'clinical_notes',
    'prescriptions',
    'prescription_items',
    'record_access_logs'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$
        CREATE POLICY tenant_isolation ON %I
          USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
          WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
      $p$,
      t
    );
    EXECUTE format(
      $p$
        CREATE POLICY read_only_write ON %I AS RESTRICTIVE
          FOR ALL
          USING (true)
          WITH CHECK (NOT public.app_read_only())
      $p$,
      t
    );
    EXECUTE format(
      $p$
        CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
          FOR DELETE
          USING (NOT public.app_read_only())
      $p$,
      t
    );
  END LOOP;

  -- The second key. Restrictive, so it ANDs with tenant isolation: a row must
  -- belong to this hospital AND the transaction must hold clinical access.
  -- Applies to reads as well as writes — that is the point.
  FOREACH t IN ARRAY ARRAY[
    'consultation_drafts',
    'diagnoses',
    'clinical_notes',
    'prescriptions',
    'prescription_items'
  ]
  LOOP
    EXECUTE format(
      $p$
        CREATE POLICY clinical_access ON %I AS RESTRICTIVE
          FOR ALL
          USING (public.app_clinical_access())
          WITH CHECK (public.app_clinical_access())
      $p$,
      t
    );
  END LOOP;
END
$outer$;
