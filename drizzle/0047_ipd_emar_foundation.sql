-- 0047_ipd_emar_foundation.sql — IPD Doctor Rounding Cockpit & eMAR Foundation (SPEC-IPD-EMAR-001)
--
-- Establishes closed-loop inpatient medication management:
-- 1. Explicit ANSI SQL constraint on admissions for composite tenant/encounter matching.
-- 2. Daily doctor clinical evaluations (ipd_clinical_rounds) with note immutability triggers.
-- 3. Inpatient medication orders (ipd_medication_orders) with independent lifecycles,
--    discrete administration routes, structured clock schedules, and signed instruction immutability.
-- 4. Append-only state transition audit trail (ipd_medication_order_actions).
-- 5. Closed-loop bedside administration event log (ipd_medication_administrations) with
--    deterministic scheduled occurrence uniqueness and void-only enforcement.
-- 6. Admission allergy tracking (ipd_allergy_assessments) with revision retention.
-- 7. Hospital clinical order sets (ipd_order_sets, ipd_order_set_items) with trigger-enforced template immutability.
-- 8. Transactional integration outbox (ipd_emar_integration_outbox) for billing and risk-stock movements.
-- 9. Exhaustive PostgreSQL Row-Level Security (FORCE ROW LEVEL SECURITY) across all new tables.

ALTER TABLE admissions DROP CONSTRAINT IF EXISTS admissions_tenant_encounter_uq;
--> statement-breakpoint
ALTER TABLE admissions ADD CONSTRAINT admissions_tenant_encounter_uq UNIQUE USING INDEX admissions_tenant_encounter_key;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_clinical_rounds */

CREATE TABLE IF NOT EXISTS ipd_clinical_rounds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  author_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  evaluation_notes TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'signed')),
  version INTEGER NOT NULL DEFAULT 1,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_clinical_rounds_signed_chk CHECK (
    (status = 'draft' AND signed_at IS NULL) OR
    (status = 'signed' AND signed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_clinical_rounds_tenant_key ON ipd_clinical_rounds (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_clinical_rounds_tenant_admission_key ON ipd_clinical_rounds (hospital_id, admission_id, id);
--> statement-breakpoint
ALTER TABLE ipd_clinical_rounds DROP CONSTRAINT IF EXISTS ipd_clinical_rounds_tenant_fk;
--> statement-breakpoint
ALTER TABLE ipd_clinical_rounds ADD CONSTRAINT ipd_clinical_rounds_tenant_fk
  FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
  REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_clinical_rounds DROP CONSTRAINT IF EXISTS ipd_clinical_rounds_doctor_fk;
--> statement-breakpoint
ALTER TABLE ipd_clinical_rounds ADD CONSTRAINT ipd_clinical_rounds_doctor_fk
  FOREIGN KEY (hospital_id, doctor_id)
  REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_medication_orders */

CREATE TABLE IF NOT EXISTS ipd_medication_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  order_chain_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  medicine_name TEXT NOT NULL,
  strength TEXT,
  form TEXT,
  dose_amount NUMERIC(8, 2) NOT NULL,
  dose_unit TEXT NOT NULL,
  route TEXT NOT NULL CHECK (route IN (
    'oral', 'iv_push', 'iv_piggyback', 'im', 'sc',
    'nebulization', 'topical', 'inhalation', 'sublingual',
    'rectal', 'ophthalmic', 'otic'
  )),
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('scheduled', 'prn', 'stat')),
  frequency_code TEXT,
  schedule_times JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_prn BOOLEAN NOT NULL DEFAULT false,
  prn_indication TEXT,
  prn_max_daily_doses SMALLINT,
  prn_max_daily_quantity NUMERIC(8, 2),
  prn_max_daily_unit TEXT,
  prn_min_interval_hours SMALLINT,
  special_instructions TEXT,
  origin TEXT NOT NULL DEFAULT 'inpatient_order' CHECK (origin IN ('inpatient_order', 'home_medication')),
  patient_supplied BOOLEAN NOT NULL DEFAULT false,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ,
  duration_days SMALLINT CHECK (duration_days IS NULL OR duration_days BETWEEN 1 AND 365),
  status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'on_hold', 'discontinued', 'completed', 'superseded', 'voided')),
  supersedes_order_id UUID,
  superseded_by_order_id UUID,
  order_set_id UUID,
  order_set_version INTEGER,
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  prescriber_doctor_id UUID NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  signed_at TIMESTAMPTZ,
  round_note_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_med_orders_signed_chk CHECK (
    (status = 'draft' AND signed_at IS NULL) OR
    (status != 'draft' AND signed_at IS NOT NULL)
  ),
  CONSTRAINT ipd_med_orders_superseded_chk CHECK (
    (status = 'superseded' AND superseded_by_order_id IS NOT NULL) OR
    (status != 'superseded' AND superseded_by_order_id IS NULL)
  ),
  CONSTRAINT ipd_med_orders_void_chk CHECK (
    (status = 'voided' AND voided_at IS NOT NULL AND void_reason IS NOT NULL) OR
    (status != 'voided' AND voided_at IS NULL AND void_reason IS NULL)
  ),
  CONSTRAINT ipd_med_orders_prn_chk CHECK (
    (is_prn = false AND prn_indication IS NULL) OR
    (is_prn = true AND prn_indication IS NOT NULL AND prn_max_daily_doses IS NOT NULL)
  ),
  CONSTRAINT ipd_med_orders_schedule_chk CHECK (
    (schedule_type = 'prn' AND is_prn = true) OR
    (schedule_type != 'prn' AND is_prn = false)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_med_orders_tenant_key ON ipd_medication_orders (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_med_orders_tenant_admission_key ON ipd_medication_orders (hospital_id, admission_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_med_orders_active_idx ON ipd_medication_orders (hospital_id, admission_id, status)
  WHERE status IN ('active', 'on_hold');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_med_orders_chain_idx ON ipd_medication_orders (hospital_id, order_chain_id);
--> statement-breakpoint
ALTER TABLE ipd_medication_orders DROP CONSTRAINT IF EXISTS ipd_med_orders_tenant_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders ADD CONSTRAINT ipd_med_orders_tenant_fk
  FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
  REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders DROP CONSTRAINT IF EXISTS ipd_med_orders_medicine_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders ADD CONSTRAINT ipd_med_orders_medicine_fk
  FOREIGN KEY (hospital_id, medicine_id)
  REFERENCES medicines (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders DROP CONSTRAINT IF EXISTS ipd_med_orders_doctor_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders ADD CONSTRAINT ipd_med_orders_doctor_fk
  FOREIGN KEY (hospital_id, prescriber_doctor_id)
  REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders DROP CONSTRAINT IF EXISTS ipd_med_orders_round_note_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders ADD CONSTRAINT ipd_med_orders_round_note_fk
  FOREIGN KEY (hospital_id, admission_id, round_note_id)
  REFERENCES ipd_clinical_rounds (hospital_id, admission_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders DROP CONSTRAINT IF EXISTS ipd_med_orders_supersedes_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders ADD CONSTRAINT ipd_med_orders_supersedes_fk
  FOREIGN KEY (hospital_id, supersedes_order_id)
  REFERENCES ipd_medication_orders (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders DROP CONSTRAINT IF EXISTS ipd_med_orders_superseded_by_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_orders ADD CONSTRAINT ipd_med_orders_superseded_by_fk
  FOREIGN KEY (hospital_id, superseded_by_order_id)
  REFERENCES ipd_medication_orders (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_medication_order_actions */

CREATE TABLE IF NOT EXISTS ipd_medication_order_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  order_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('sign', 'hold', 'resume', 'discontinue', 'modify', 'renew', 'expire', 'void')),
  reason TEXT,
  actor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  doctor_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_order_actions_reason_chk CHECK (
    action IN ('sign', 'expire') OR (reason IS NOT NULL AND char_length(reason) >= 3)
  )
);
--> statement-breakpoint
ALTER TABLE ipd_medication_order_actions DROP CONSTRAINT IF EXISTS ipd_order_actions_order_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_order_actions ADD CONSTRAINT ipd_order_actions_order_fk
  FOREIGN KEY (hospital_id, order_id)
  REFERENCES ipd_medication_orders (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_order_actions DROP CONSTRAINT IF EXISTS ipd_order_actions_doctor_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_order_actions ADD CONSTRAINT ipd_order_actions_doctor_fk
  FOREIGN KEY (hospital_id, doctor_id)
  REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_medication_administrations */

CREATE TABLE IF NOT EXISTS ipd_medication_administrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  order_id UUID NOT NULL,
  order_chain_id UUID NOT NULL,
  client_id UUID NOT NULL,
  scheduled_time TIMESTAMPTZ,
  actual_time TIMESTAMPTZ,
  decision_time TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('administered', 'omitted', 'refused', 'held')),
  dose_given TEXT,
  dose_amount_numeric NUMERIC(8, 2),
  route_given TEXT,
  non_admin_reason TEXT,
  clinical_note TEXT,
  nurse_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT,
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  void_reason TEXT,
  corrects_administration_id UUID,
  corrected_by_administration_id UUID,
  care_entry_id UUID,
  stock_ledger_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_med_admin_void_chk CHECK ((voided_at IS NULL) = (void_reason IS NULL)),
  CONSTRAINT ipd_med_admin_timing_chk CHECK (
    (outcome = 'administered' AND actual_time IS NOT NULL AND decision_time IS NULL AND non_admin_reason IS NULL) OR
    (outcome != 'administered' AND actual_time IS NULL AND decision_time IS NOT NULL AND non_admin_reason IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_med_admin_tenant_key ON ipd_medication_administrations (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_med_admin_client_key ON ipd_medication_administrations (hospital_id, client_id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_med_admin_scheduled_occurrence_key
  ON ipd_medication_administrations (hospital_id, order_id, scheduled_time)
  WHERE voided_at IS NULL AND scheduled_time IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_med_admin_admission_time_idx ON ipd_medication_administrations
  (hospital_id, admission_id, recorded_at) WHERE voided_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_med_admin_chain_time_idx ON ipd_medication_administrations
  (hospital_id, order_chain_id, actual_time)
  WHERE voided_at IS NULL AND outcome = 'administered';
--> statement-breakpoint
ALTER TABLE ipd_medication_administrations DROP CONSTRAINT IF EXISTS ipd_med_admin_order_admission_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_administrations ADD CONSTRAINT ipd_med_admin_order_admission_fk
  FOREIGN KEY (hospital_id, admission_id, order_id)
  REFERENCES ipd_medication_orders (hospital_id, admission_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_administrations DROP CONSTRAINT IF EXISTS ipd_med_admin_corrects_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_administrations ADD CONSTRAINT ipd_med_admin_corrects_fk
  FOREIGN KEY (hospital_id, corrects_administration_id)
  REFERENCES ipd_medication_administrations (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE ipd_medication_administrations DROP CONSTRAINT IF EXISTS ipd_med_admin_corrected_by_fk;
--> statement-breakpoint
ALTER TABLE ipd_medication_administrations ADD CONSTRAINT ipd_med_admin_corrected_by_fk
  FOREIGN KEY (hospital_id, corrected_by_administration_id)
  REFERENCES ipd_medication_administrations (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_allergy_assessments */

CREATE TABLE IF NOT EXISTS ipd_allergy_assessments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unreviewed', 'nkda', 'allergies_documented')),
  allergens JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_current BOOLEAN NOT NULL DEFAULT true,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE RESTRICT,
  reviewed_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_allergy_review_chk CHECK (
    (status = 'unreviewed' AND reviewed_by_user_id IS NULL AND reviewed_at IS NULL) OR
    (status IN ('nkda', 'allergies_documented') AND reviewed_by_user_id IS NOT NULL AND reviewed_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_allergy_current_idx
  ON ipd_allergy_assessments (hospital_id, admission_id)
  WHERE is_current = true;
--> statement-breakpoint
ALTER TABLE ipd_allergy_assessments DROP CONSTRAINT IF EXISTS ipd_allergy_assessments_tenant_fk;
--> statement-breakpoint
ALTER TABLE ipd_allergy_assessments ADD CONSTRAINT ipd_allergy_assessments_tenant_fk
  FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
  REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_order_sets & items */

CREATE TABLE IF NOT EXISTS ipd_order_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'approved', 'deprecated')),
  approved_by_doctor_id UUID,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ipd_order_sets_approved_chk CHECK (
    (status IN ('draft', 'pending_review') AND approved_by_doctor_id IS NULL AND approved_at IS NULL) OR
    (status IN ('approved', 'deprecated') AND approved_by_doctor_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_order_sets_hospital_id_key ON ipd_order_sets (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_order_sets_hospital_code_ver ON ipd_order_sets (hospital_id, code, version);
--> statement-breakpoint
ALTER TABLE ipd_order_sets DROP CONSTRAINT IF EXISTS ipd_order_sets_doctor_fk;
--> statement-breakpoint
ALTER TABLE ipd_order_sets ADD CONSTRAINT ipd_order_sets_doctor_fk
  FOREIGN KEY (hospital_id, approved_by_doctor_id)
  REFERENCES doctors (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS ipd_order_set_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  order_set_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  default_dose_amount NUMERIC(8, 2) NOT NULL,
  default_dose_unit TEXT NOT NULL,
  default_route TEXT NOT NULL CHECK (default_route IN (
    'oral', 'iv_push', 'iv_piggyback', 'im', 'sc',
    'nebulization', 'topical', 'inhalation', 'sublingual',
    'rectal', 'ophthalmic', 'otic'
  )),
  default_schedule_type TEXT NOT NULL CHECK (default_schedule_type IN ('scheduled', 'prn', 'stat')),
  default_frequency_code TEXT,
  default_schedule_times JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_duration_days SMALLINT,
  default_instructions TEXT,
  sort_order SMALLINT NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_order_set_items_set_idx ON ipd_order_set_items (hospital_id, order_set_id, sort_order);
--> statement-breakpoint
ALTER TABLE ipd_order_set_items DROP CONSTRAINT IF EXISTS ipd_order_set_items_set_fk;
--> statement-breakpoint
ALTER TABLE ipd_order_set_items ADD CONSTRAINT ipd_order_set_items_set_fk
  FOREIGN KEY (hospital_id, order_set_id)
  REFERENCES ipd_order_sets (hospital_id, id) ON DELETE CASCADE;
--> statement-breakpoint
ALTER TABLE ipd_order_set_items DROP CONSTRAINT IF EXISTS ipd_order_set_items_medicine_fk;
--> statement-breakpoint
ALTER TABLE ipd_order_set_items ADD CONSTRAINT ipd_order_set_items_medicine_fk
  FOREIGN KEY (hospital_id, medicine_id)
  REFERENCES medicines (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- ipd_emar_integration_outbox */

CREATE TABLE IF NOT EXISTS ipd_emar_integration_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE RESTRICT,
  administration_id UUID NOT NULL,
  integration_type TEXT NOT NULL CHECK (integration_type IN ('billing', 'stock')),
  event_type TEXT NOT NULL CHECK (event_type IN ('administer', 'void', 'correction')),
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'pending_pricing', 'processing', 'processed', 'failed', 'skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  scheduled_for TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  last_error TEXT,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_emar_outbox_event_key
  ON ipd_emar_integration_outbox (hospital_id, administration_id, integration_type, event_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ipd_emar_outbox_pending_idx
  ON ipd_emar_integration_outbox (hospital_id, status, scheduled_for)
  WHERE status = 'pending';
--> statement-breakpoint
ALTER TABLE ipd_emar_integration_outbox DROP CONSTRAINT IF EXISTS ipd_emar_outbox_admin_fk;
--> statement-breakpoint
ALTER TABLE ipd_emar_integration_outbox ADD CONSTRAINT ipd_emar_outbox_admin_fk
  FOREIGN KEY (hospital_id, administration_id)
  REFERENCES ipd_medication_administrations (hospital_id, id) ON DELETE RESTRICT;
--> statement-breakpoint

/* ------------------------------------------------------- immutability & audit triggers */

CREATE OR REPLACE FUNCTION ipd_enforce_signed_order_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.signed_at IS NOT NULL THEN
    IF NEW.medicine_id <> OLD.medicine_id OR
       NEW.dose_amount <> OLD.dose_amount OR
       NEW.dose_unit <> OLD.dose_unit OR
       NEW.route <> OLD.route OR
       NEW.schedule_type <> OLD.schedule_type OR
       NEW.schedule_times <> OLD.schedule_times OR
       NEW.is_prn <> OLD.is_prn OR
       NEW.starts_at <> OLD.starts_at OR
       NEW.ends_at <> OLD.ends_at OR
       NEW.duration_days IS DISTINCT FROM OLD.duration_days OR
       NEW.prescriber_doctor_id <> OLD.prescriber_doctor_id OR
       NEW.origin <> OLD.origin OR
       NEW.patient_supplied <> OLD.patient_supplied OR
       NEW.signed_at <> OLD.signed_at THEN
      RAISE EXCEPTION 'Signed clinical medication instructions are immutable. To modify dosage, timing, or duration, authorize a successor order version.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ipd_med_orders_immutable ON ipd_medication_orders;
--> statement-breakpoint
CREATE TRIGGER trg_ipd_med_orders_immutable
  BEFORE UPDATE ON ipd_medication_orders
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_signed_order_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ipd_enforce_signed_round_immutability()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'signed' THEN
    IF NEW.evaluation_notes <> OLD.evaluation_notes OR NEW.signed_at <> OLD.signed_at THEN
      RAISE EXCEPTION 'Signed clinical round notes cannot be modified. Record an addendum or a new round evaluation.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ipd_clinical_rounds_immutable ON ipd_clinical_rounds;
--> statement-breakpoint
CREATE TRIGGER trg_ipd_clinical_rounds_immutable
  BEFORE UPDATE ON ipd_clinical_rounds
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_signed_round_immutability();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ipd_prevent_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Clinical action audit history is strictly append-only. Modification or deletion is forbidden.';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ipd_order_actions_append_only ON ipd_medication_order_actions;
--> statement-breakpoint
CREATE TRIGGER trg_ipd_order_actions_append_only
  BEFORE UPDATE OR DELETE ON ipd_medication_order_actions
  FOR EACH ROW EXECUTE FUNCTION ipd_prevent_audit_mutation();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ipd_enforce_admin_void_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Administration records cannot be deleted; invoke void/strike-through workflow.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.outcome IS NOT NULL AND (
       NEW.outcome <> OLD.outcome OR
       NEW.actual_time IS DISTINCT FROM OLD.actual_time OR
       NEW.dose_given IS DISTINCT FROM OLD.dose_given OR
       NEW.nurse_user_id <> OLD.nurse_user_id) THEN
      RAISE EXCEPTION 'Clinical administration details are immutable. Voids must preserve original execution data.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ipd_med_admin_void_only ON ipd_medication_administrations;
--> statement-breakpoint
CREATE TRIGGER trg_ipd_med_admin_void_only
  BEFORE UPDATE OR DELETE ON ipd_medication_administrations
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_admin_void_only();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION ipd_enforce_order_set_immutability()
RETURNS TRIGGER AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF TG_TABLE_NAME = 'ipd_order_sets' THEN
    IF OLD.status IN ('approved', 'deprecated') THEN
      IF TG_OP = 'DELETE' OR NEW.code <> OLD.code OR NEW.name <> OLD.name OR NEW.version <> OLD.version THEN
        RAISE EXCEPTION 'Approved order sets are immutable. Author a new version to modify.';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'ipd_order_set_items' THEN
    SELECT status INTO v_status FROM ipd_order_sets WHERE id = COALESCE(NEW.order_set_id, OLD.order_set_id);
    IF v_status IN ('approved', 'deprecated') THEN
      RAISE EXCEPTION 'Items in an approved order set are immutable. Author a new template version to modify items.';
    END IF;
    RETURN COALESCE(NEW, OLD);
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ipd_order_sets_immutable ON ipd_order_sets;
--> statement-breakpoint
CREATE TRIGGER trg_ipd_order_sets_immutable
  BEFORE UPDATE OR DELETE ON ipd_order_sets
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_order_set_immutability();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_ipd_order_set_items_immutable ON ipd_order_set_items;
--> statement-breakpoint
CREATE TRIGGER trg_ipd_order_set_items_immutable
  BEFORE INSERT OR UPDATE OR DELETE ON ipd_order_set_items
  FOR EACH ROW EXECUTE FUNCTION ipd_enforce_order_set_immutability();
--> statement-breakpoint

/* ------------------------------------------------------- row level security */

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ipd_clinical_rounds',
    'ipd_medication_orders',
    'ipd_medication_order_actions',
    'ipd_medication_administrations',
    'ipd_allergy_assessments',
    'ipd_order_sets',
    'ipd_order_set_items',
    'ipd_emar_integration_outbox'
  ] LOOP
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

  FOREACH t IN ARRAY ARRAY[
    'ipd_clinical_rounds',
    'ipd_medication_orders',
    'ipd_medication_order_actions',
    'ipd_medication_administrations',
    'ipd_allergy_assessments'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access())
         WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;
END
$outer$;
