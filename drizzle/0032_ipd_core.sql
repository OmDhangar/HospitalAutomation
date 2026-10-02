-- IPD: wards and beds, admissions, bed assignments, bedside care entries,
-- the non-medicine price list, payers, and the bill lines they produce.
-- docs/plans/ipd-mvp-implementation-plan.md §3.2 is the design; this is it.
--
-- The rules that shape it:
--
--   1. An admission hangs off the SAME encounter as the OPD visit that led to
--      it. "Shift to IPD" turns encounters.stage to 'ipd'; it never opens a
--      second episode, so there is never a question of which row the bill and
--      the history belong to.
--
--   2. What was given at the bedside (care_entries) is a clinical record and
--      is never edited, only voided. What it costs is a separate bill line,
--      priced by the server from the catalogue at the moment it was recorded
--      (this reverses D20: IPD items are no longer added at the desk).
--
--   3. Every bill line names its source in a typed column with its own "bill
--      this at most once" index: a care entry is billed once, a bed is billed
--      once per day.
--
--   4. Configuration (charge items, wards, beds) is edited freely. Records
--      (care entries, payers, bed history) are corrected by voiding or by
--      closing, and triggers make that the only way.

/* ------------------------------------------------- tenant keys on masters */

-- Targets for composite (hospital_id, …) keys below. Foreign-key checks ignore
-- row-level security, so a ward pointing at branches(id) alone could name
-- another hospital's branch. Ids are already unique, so these cannot fail.
CREATE UNIQUE INDEX IF NOT EXISTS branches_tenant_key ON branches (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS doctors_tenant_key ON doctors (hospital_id, id);
--> statement-breakpoint

/* ------------------------------------------------------------------ enums */

CREATE TYPE admission_status AS ENUM
  ('awaiting_bed', 'admitted', 'discharge_ready', 'discharged', 'cancelled');
--> statement-breakpoint
CREATE TYPE charge_item_kind AS ENUM ('consumable', 'procedure', 'service', 'room');
--> statement-breakpoint
CREATE TYPE payer_kind AS ENUM ('self', 'insurer', 'tpa', 'corporate');
--> statement-breakpoint

/* ----------------------------------------------------------- charge items */

-- Everything chargeable that is not a medicine: syringes, dressings, oxygen,
-- tests, a bed-day. Medicines stay in `medicines`, because prescriptions
-- reference them. Like medicines, a null price means "not priced yet": it
-- can be recorded at the bedside, and is flagged for the owner, never blocked.
CREATE TABLE charge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  kind charge_item_kind NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  -- What one unit of quantity means on a bill: syringe, pair, hour, day.
  unit TEXT NOT NULL DEFAULT 'unit' CHECK (char_length(unit) BETWEEN 1 AND 20),
  selling_price_paise INTEGER CHECK (selling_price_paise >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  -- A lab or imaging test; the doctor's Tests chips (T3.1) are these.
  is_test BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT charge_items_test_is_service CHECK (NOT is_test OR kind = 'service')
);
--> statement-breakpoint
CREATE UNIQUE INDEX charge_items_tenant_key ON charge_items (hospital_id, id);
--> statement-breakpoint
-- One "Syringe 5 ml" per kind, however it is capitalised: re-running the
-- starter list or a CSV import is an insert that does nothing.
CREATE UNIQUE INDEX charge_items_identity_key ON charge_items (hospital_id, kind, lower(name));
--> statement-breakpoint
CREATE INDEX charge_items_name_search_idx
  ON charge_items (hospital_id, lower(name) text_pattern_ops)
  WHERE active;
--> statement-breakpoint

/* ---------------------------------------------------------- wards and beds */

CREATE TABLE wards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  -- The room charge per day (a charge item of kind 'room'). Null = no
  -- nightly bed-day line for this ward.
  daily_charge_item_id UUID,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wards_branch_fk FOREIGN KEY (hospital_id, branch_id)
    REFERENCES branches (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT wards_daily_charge_fk FOREIGN KEY (hospital_id, daily_charge_item_id)
    REFERENCES charge_items (hospital_id, id)
);
--> statement-breakpoint
CREATE UNIQUE INDEX wards_tenant_key ON wards (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX wards_name_key ON wards (hospital_id, branch_id, lower(name));
--> statement-breakpoint

CREATE TABLE beds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  ward_id UUID NOT NULL,
  -- As painted on the wall: "12", "ICU-3".
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 20),
  sort_order SMALLINT NOT NULL DEFAULT 0,
  -- Never deleted once it has history; deactivated instead.
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT beds_ward_fk FOREIGN KEY (hospital_id, ward_id)
    REFERENCES wards (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX beds_tenant_key ON beds (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX beds_label_key ON beds (ward_id, lower(label));
--> statement-breakpoint

/* ------------------------------------------------------------- admissions */

-- Clinical. One stay, from "Shift to IPD" (or an emergency admission) to
-- discharge. A cancelled request stays as history; a new request for the
-- same encounter is a new row.
CREATE TABLE admissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  branch_id UUID NOT NULL,
  -- NO ACTION: doctors are deactivated, never deleted.
  admitting_doctor_id UUID NOT NULL,
  status admission_status NOT NULL DEFAULT 'awaiting_bed',
  reason TEXT CHECK (reason IS NULL OR char_length(reason) <= 200),
  requested_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  admitted_at TIMESTAMPTZ,
  admitted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  discharge_ready_at TIMESTAMPTZ,
  discharge_ready_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  discharged_at TIMESTAMPTZ,
  discharged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admissions_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE,
  CONSTRAINT admissions_branch_fk FOREIGN KEY (hospital_id, branch_id)
    REFERENCES branches (hospital_id, id),
  CONSTRAINT admissions_doctor_fk FOREIGN KEY (hospital_id, admitting_doctor_id)
    REFERENCES doctors (hospital_id, id),
  -- Each later state carries its stamp. The service owns the transitions;
  -- these make a half-written state unstorable.
  CONSTRAINT admissions_admitted_stamped CHECK (
    status NOT IN ('admitted', 'discharge_ready', 'discharged') OR admitted_at IS NOT NULL
  ),
  CONSTRAINT admissions_ready_stamped CHECK (
    status <> 'discharge_ready' OR discharge_ready_at IS NOT NULL
  ),
  CONSTRAINT admissions_discharged_stamped CHECK ((status = 'discharged') = (discharged_at IS NOT NULL)),
  CONSTRAINT admissions_cancelled_stamped CHECK (
    (status = 'cancelled') = (cancelled_at IS NOT NULL AND cancel_reason IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX admissions_tenant_key ON admissions (hospital_id, id);
--> statement-breakpoint
-- Target for care_entries: same hospital, same encounter, same patient.
CREATE UNIQUE INDEX admissions_tenant_encounter_key
  ON admissions (hospital_id, id, encounter_id, patient_id);
--> statement-breakpoint
-- A second "Shift to IPD" tap (or two people at once) finds the live one
-- instead of creating a duplicate.
CREATE UNIQUE INDEX admissions_one_live_per_encounter
  ON admissions (encounter_id) WHERE status <> 'cancelled';
--> statement-breakpoint
-- The IPD home: awaiting bed, the wards, discharge ready.
CREATE INDEX admissions_census_idx ON admissions (hospital_id, branch_id, status)
  WHERE status IN ('awaiting_bed', 'admitted', 'discharge_ready');
--> statement-breakpoint
CREATE INDEX admissions_doctor_idx ON admissions (admitting_doctor_id)
  WHERE status IN ('admitted', 'discharge_ready');
--> statement-breakpoint

/* -------------------------------------------------------- bed assignments */

-- Which bed, from when to when. A transfer closes one row and opens another
-- in the same transaction, so the history of a stay is exact and the
-- bed-day charge knows which ward each day belongs to.
CREATE TABLE bed_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  bed_id UUID NOT NULL,
  from_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  to_at TIMESTAMPTZ,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bed_assignments_admission_fk FOREIGN KEY (hospital_id, admission_id)
    REFERENCES admissions (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT bed_assignments_bed_fk FOREIGN KEY (hospital_id, bed_id)
    REFERENCES beds (hospital_id, id),
  CONSTRAINT bed_assignments_span CHECK (to_at IS NULL OR to_at >= from_at)
);
--> statement-breakpoint
CREATE UNIQUE INDEX bed_assignments_tenant_key ON bed_assignments (hospital_id, id);
--> statement-breakpoint
-- One patient per bed, one bed per patient. Two receptionists picking Bed 12
-- at once: the second insert fails here and is told to pick another.
CREATE UNIQUE INDEX bed_assignments_bed_occupied ON bed_assignments (bed_id) WHERE to_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX bed_assignments_admission_current
  ON bed_assignments (admission_id) WHERE to_at IS NULL;
--> statement-breakpoint
CREATE INDEX bed_assignments_admission_idx ON bed_assignments (admission_id, from_at);
--> statement-breakpoint

/* ----------------------------------------------------------- care entries */

-- Clinical. What was given or used at the bedside: one medicine or one
-- charge item, a quantity, when, and by whom.
CREATE TABLE care_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  -- Exactly one. NO ACTION: catalogue rows are deactivated, never deleted.
  medicine_id UUID,
  charge_item_id UUID,
  -- What the nurse saw and tapped: "Inj. Ceftriaxone 1 g". Rename-proof.
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  quantity INTEGER NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  -- When it was given; may be a little before it was recorded.
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Generated on the phone. A retry from the offline outbox carries the same
  -- id, so it finds the first row instead of recording the dose twice.
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT care_entries_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT care_entries_medicine_fk FOREIGN KEY (hospital_id, medicine_id)
    REFERENCES medicines (hospital_id, id),
  CONSTRAINT care_entries_charge_item_fk FOREIGN KEY (hospital_id, charge_item_id)
    REFERENCES charge_items (hospital_id, id),
  CONSTRAINT care_entries_one_item CHECK (num_nonnulls(medicine_id, charge_item_id) = 1),
  -- A clock a few minutes fast on the phone is fine; the future is not.
  CONSTRAINT care_entries_not_future CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  CONSTRAINT care_entries_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX care_entries_tenant_key ON care_entries (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX care_entries_client_key ON care_entries (hospital_id, client_id);
--> statement-breakpoint
CREATE INDEX care_entries_admission_idx ON care_entries (admission_id, occurred_at)
  WHERE voided_at IS NULL;
--> statement-breakpoint
-- "Not priced yet" back-fill: when the owner prices an item, its unbilled
-- entries are found by item.
CREATE INDEX care_entries_medicine_idx ON care_entries (medicine_id)
  WHERE medicine_id IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint
CREATE INDEX care_entries_charge_item_idx ON care_entries (charge_item_id)
  WHERE charge_item_id IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint

CREATE TRIGGER care_entries_void_only
  BEFORE UPDATE ON care_entries
  FOR EACH ROW EXECUTE FUNCTION void_only_guard('recorded_by_user_id', 'voided_by_user_id');
--> statement-breakpoint

-- A bed assignment may only be closed, once. Anything else would rewrite
-- where the patient was, which the bed-day charge depends on.
CREATE OR REPLACE FUNCTION bed_assignments_guard() RETURNS trigger AS $fn$
BEGIN
  IF only_user_refs_cleared(to_jsonb(OLD), to_jsonb(NEW), ARRAY['assigned_by_user_id']) THEN
    RETURN NEW;
  END IF;
  IF OLD.to_at IS NULL
     AND NEW.to_at IS NOT NULL
     AND (to_jsonb(OLD) - 'to_at') = (to_jsonb(NEW) - 'to_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bed assignment % can only be closed, once', OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bed_assignments_guard
  BEFORE UPDATE ON bed_assignments
  FOR EACH ROW EXECUTE FUNCTION bed_assignments_guard();
--> statement-breakpoint

/* ----------------------------------------------------------------- payers */

-- Who pays for the encounter, recorded by reception at admission (moved from
-- the Stage 2 migration on 2 Oct 2026). Billing data, not clinical. A change
-- at discharge voids the row and inserts a new one.
CREATE TABLE encounter_payers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  kind payer_kind NOT NULL,
  payer_name TEXT CHECK (payer_name IS NULL OR char_length(payer_name) <= 120),
  policy_number TEXT CHECK (policy_number IS NULL OR char_length(policy_number) <= 60),
  preauth_amount_paise INTEGER CHECK (preauth_amount_paise >= 0),
  approved_amount_paise INTEGER CHECK (approved_amount_paise >= 0),
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT encounter_payers_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE,
  CONSTRAINT encounter_payers_named CHECK (kind = 'self' OR payer_name IS NOT NULL),
  CONSTRAINT encounter_payers_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX encounter_payers_tenant_key ON encounter_payers (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX encounter_payers_one_active ON encounter_payers (encounter_id)
  WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE TRIGGER encounter_payers_void_only
  BEFORE UPDATE ON encounter_payers
  FOR EACH ROW EXECUTE FUNCTION void_only_guard('created_by_user_id', 'voided_by_user_id');
--> statement-breakpoint

/* ------------------------------------------------- bill items: IPD sources */

-- Typed nullable sources, one "bill once" index each — the convention 0026
-- set for consultations.
ALTER TABLE bill_items
  ADD COLUMN medicine_id UUID,
  ADD COLUMN charge_item_id UUID,
  ADD COLUMN care_entry_id UUID,
  ADD COLUMN bed_assignment_id UUID,
  -- The day a room line charges for. Only room lines carry it.
  ADD COLUMN service_date DATE;
--> statement-breakpoint
ALTER TABLE bill_items
  ADD CONSTRAINT bill_items_medicine_fk FOREIGN KEY (hospital_id, medicine_id)
    REFERENCES medicines (hospital_id, id),
  ADD CONSTRAINT bill_items_charge_item_fk FOREIGN KEY (hospital_id, charge_item_id)
    REFERENCES charge_items (hospital_id, id),
  ADD CONSTRAINT bill_items_care_entry_fk FOREIGN KEY (hospital_id, care_entry_id)
    REFERENCES care_entries (hospital_id, id),
  ADD CONSTRAINT bill_items_bed_assignment_fk FOREIGN KEY (hospital_id, bed_assignment_id)
    REFERENCES bed_assignments (hospital_id, id);
--> statement-breakpoint
-- Each item type has exactly its own source. Existing rows are consultation
-- or other with every new column null, so they satisfy the new CHECK.
ALTER TABLE bill_items DROP CONSTRAINT bill_items_source;
--> statement-breakpoint
ALTER TABLE bill_items ADD CONSTRAINT bill_items_source CHECK (
  (item_type = 'consultation' AND service_id IS NOT NULL
    AND medicine_id IS NULL AND charge_item_id IS NULL AND care_entry_id IS NULL
    AND bed_assignment_id IS NULL AND service_date IS NULL)
  OR (item_type = 'other' AND service_id IS NULL AND appointment_id IS NULL
    AND medicine_id IS NULL AND charge_item_id IS NULL AND care_entry_id IS NULL
    AND bed_assignment_id IS NULL AND service_date IS NULL)
  OR (item_type = 'medicine' AND medicine_id IS NOT NULL
    AND service_id IS NULL AND appointment_id IS NULL AND charge_item_id IS NULL
    AND bed_assignment_id IS NULL AND service_date IS NULL)
  OR (item_type IN ('consumable', 'procedure', 'service') AND charge_item_id IS NOT NULL
    AND service_id IS NULL AND appointment_id IS NULL AND medicine_id IS NULL
    AND bed_assignment_id IS NULL AND service_date IS NULL)
  OR (item_type = 'room' AND charge_item_id IS NOT NULL
    AND bed_assignment_id IS NOT NULL AND service_date IS NOT NULL
    AND service_id IS NULL AND appointment_id IS NULL AND medicine_id IS NULL
    AND care_entry_id IS NULL)
);
--> statement-breakpoint
-- A bedside entry is charged at most once, however many times it is retried.
CREATE UNIQUE INDEX bill_items_care_entry_once ON bill_items (care_entry_id)
  WHERE care_entry_id IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint
-- A bed is charged at most once per day, however often the sweep runs.
CREATE UNIQUE INDEX bill_items_bed_day_once ON bill_items (bed_assignment_id, service_date)
  WHERE bed_assignment_id IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint

/* ------------------------------------------------------------- access log */

-- Opening a patient's IPD page reads their record, so it is logged like a
-- history view (DPDP). The CHECK lists the actions; this adds IPD's.
ALTER TABLE record_access_logs DROP CONSTRAINT IF EXISTS record_access_logs_action_check;
--> statement-breakpoint
ALTER TABLE record_access_logs ADD CONSTRAINT record_access_logs_action_check
  CHECK (action IN ('view_history', 'print_prescription', 'view_admission', 'print_ipd_bill'));
--> statement-breakpoint

/* ---------------------------------------------------------------- tenancy */

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'charge_items',
    'wards',
    'beds',
    'admissions',
    'bed_assignments',
    'care_entries',
    'encounter_payers'
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

  -- The clinical key (0028): admissions and what was given at the bedside are
  -- medical records. Bed assignments, payers and the catalogue are not.
  FOREACH t IN ARRAY ARRAY[
    'admissions',
    'care_entries'
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
