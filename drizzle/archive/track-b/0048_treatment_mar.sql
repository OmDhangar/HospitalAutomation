-- 0048_treatment_mar.sql — IPD sheets plan, phase B3-min: the treatment card (doctor's orders) and the MAR.
--
--   treatment_orders      a line on the treatment card: the medicine (or an instruction), dose, route,
--                         frequency; who ordered it and who wrote it. A line written by someone other
--                         than the ordering doctor (a telephone or verbal order) is "transcribed" and
--                         needs that doctor's countersign. Lines are stopped or struck out, never edited.
--   mar_administrations   each dose: given (with the bill line it posts through a bedside entry), held,
--                         refused, not available, or omitted with a reason. Partitioned by month like
--                         chart_entries. Void-only.
--   witness_requests      a second person confirms a risk-class give (D-WITNESS): on the shared ward
--                         tablet with their own PIN, or by approving in their own signed-in session.
--                         Never the person who gave it (CHECK).
--   presence_proofs       the nurse typed (or scanned) the code on the patient's bed: proof of being at
--                         the bedside, used by a risk-class give from a personal phone within 5 minutes.
--   beds.bed_code         that code: 6 characters, unique in the hospital, printed on the bed.
--   risk_classes.witness_at_give   a class whose gives need a witness (NDPS always do).
--
-- The rules (order link, countersign, witness, bedside proof) roll out observe → warn → enforce with the
-- module's stage; what was not met is recorded on the dose (control_flags), never silently dropped.
-- Timing (due times, windows, time-critical alerts) is B3b's. Written for the runner v2: idempotent,
-- expand-only.
--
-- Rollback: switch the "Treatment card" module off (data kept, nothing shown or written). The new tables
-- and columns are unused by earlier code.

ALTER TABLE beds ADD COLUMN IF NOT EXISTS bed_code TEXT;
--> statement-breakpoint

ALTER TABLE beds DROP CONSTRAINT IF EXISTS beds_bed_code_format;
--> statement-breakpoint

-- No 0/O, 1/I/L: the code is read off a label and typed on a phone.
ALTER TABLE beds ADD CONSTRAINT beds_bed_code_format CHECK (bed_code IS NULL OR bed_code ~ '^[A-HJKMNP-Z2-9]{6}$') NOT VALID;
--> statement-breakpoint

ALTER TABLE beds VALIDATE CONSTRAINT beds_bed_code_format;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS beds_bed_code_key ON beds (hospital_id, bed_code) WHERE bed_code IS NOT NULL;
--> statement-breakpoint

ALTER TABLE risk_classes ADD COLUMN IF NOT EXISTS witness_at_give BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS treatment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('medicine', 'instruction')),
  medicine_id UUID,
  -- The medicine's name when ordered, or the instruction: a later rename does not rewrite the card.
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  dose TEXT CHECK (char_length(dose) BETWEEN 1 AND 40),
  route TEXT CHECK (route IN ('oral', 'iv', 'im', 'sc', 'sl', 'inhaled', 'topical', 'pr', 'other')),
  frequency TEXT CHECK (char_length(frequency) BETWEEN 1 AND 30),
  instructions TEXT CHECK (char_length(instructions) BETWEEN 1 AND 200),
  ordering_doctor_id UUID NOT NULL,
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Written by someone other than the ordering doctor: needs that doctor's countersign.
  transcribed BOOLEAN NOT NULL,
  countersigned_at TIMESTAMPTZ,
  countersigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  stopped_at TIMESTAMPTZ,
  stopped_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  stop_reason TEXT CHECK (char_length(stop_reason) BETWEEN 1 AND 200),
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT CHECK (char_length(recorded_device_id) <= 64),
  recorded_session_id UUID,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT treatment_orders_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT treatment_orders_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT treatment_orders_medicine_fk FOREIGN KEY (hospital_id, medicine_id) REFERENCES medicines (hospital_id, id),
  CONSTRAINT treatment_orders_doctor_fk FOREIGN KEY (hospital_id, ordering_doctor_id) REFERENCES doctors (hospital_id, id),
  CONSTRAINT treatment_orders_kind CHECK ((kind = 'medicine') = (medicine_id IS NOT NULL)),
  CONSTRAINT treatment_orders_medicine_line CHECK (kind <> 'medicine' OR (dose IS NOT NULL AND route IS NOT NULL AND frequency IS NOT NULL)),
  -- Only a transcribed line is countersigned.
  CONSTRAINT treatment_orders_countersign CHECK (countersigned_at IS NULL OR transcribed),
  CONSTRAINT treatment_orders_stopped CHECK ((stopped_at IS NULL) = (stop_reason IS NULL)),
  CONSTRAINT treatment_orders_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS treatment_orders_tenant_key ON treatment_orders (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS treatment_orders_client_key ON treatment_orders (hospital_id, client_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS treatment_orders_admission_idx ON treatment_orders (admission_id, ordered_at) WHERE voided_at IS NULL;
--> statement-breakpoint

-- A doctor's lines waiting for their countersign.
CREATE INDEX IF NOT EXISTS treatment_orders_countersign_idx ON treatment_orders (hospital_id, ordering_doctor_id)
  WHERE transcribed AND countersigned_at IS NULL AND voided_at IS NULL;
--> statement-breakpoint

/*
 * A treatment line changes only one way: countersigned once (transcribed lines only), stopped once,
 * struck out once. What was ordered, by whom and when never changes.
 */
CREATE OR REPLACE FUNCTION public.treatment_orders_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  mutable text[] := ARRAY['countersigned_at', 'countersigned_by_user_id', 'stopped_at', 'stopped_by_user_id', 'stop_reason',
                          'voided_at', 'voided_by_user_id', 'void_reason', 'entered_by_user_id'];
  k text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A treatment line cannot be deleted; strike it out' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (n - mutable) <> (o - mutable) THEN
    RAISE EXCEPTION 'A treatment line cannot be edited; stop it and write a new one' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Set once. (User references may still be cleared by ON DELETE SET NULL.)
  FOREACH k IN ARRAY ARRAY['countersigned_at', 'stopped_at', 'stop_reason', 'voided_at', 'void_reason'] LOOP
    IF o->>k IS NOT NULL AND (n->k) IS DISTINCT FROM (o->k) THEN
      RAISE EXCEPTION '% is already set', k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  FOREACH k IN ARRAY ARRAY['countersigned_by_user_id', 'stopped_by_user_id', 'voided_by_user_id', 'entered_by_user_id'] LOOP
    IF o->>k IS NOT NULL AND n->>k IS NOT NULL AND n->>k <> o->>k THEN
      RAISE EXCEPTION '% is already set', k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS treatment_orders_guard ON treatment_orders;
--> statement-breakpoint

CREATE TRIGGER treatment_orders_guard BEFORE UPDATE OR DELETE ON treatment_orders
  FOR EACH ROW EXECUTE FUNCTION public.treatment_orders_guard();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS mar_administrations (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  order_id UUID NOT NULL,
  medicine_id UUID,
  state TEXT NOT NULL CHECK (state IN ('given', 'held', 'refused', 'not_available', 'omitted')),
  -- When it was given (or should have been, for the others).
  occurred_at TIMESTAMPTZ NOT NULL,
  dose TEXT CHECK (char_length(dose) BETWEEN 1 AND 40),
  -- Billing units posted for a give (0: nothing billed, e.g. from a multi-dose vial already charged).
  quantity SMALLINT CHECK (quantity BETWEEN 0 AND 100),
  reason_code TEXT CHECK (reason_code IN ('refused', 'npo', 'away', 'not_available', 'held_by_doctor', 'late_entry', 'other')),
  reason_text TEXT CHECK (char_length(reason_text) BETWEEN 1 AND 200),
  care_entry_id UUID,
  -- Risk-class gives that need a second person (D-WITNESS).
  witness_status TEXT NOT NULL DEFAULT 'not_needed'
    CHECK (witness_status IN ('not_needed', 'awaiting', 'witnessed', 'skipped')),
  witnessed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  witnessed_at TIMESTAMPTZ,
  presence_proof_id UUID,
  -- What a rule found missing, recorded instead of refused while the module is in observe or warn.
  control_flags TEXT[] NOT NULL DEFAULT '{}'::text[] CHECK (control_flags <@ ARRAY[
    'uncountersigned_order', 'no_presence', 'no_witness', 'witness_late', 'late_entry'
  ]::text[]),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recorded_channel TEXT CHECK (recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT CHECK (char_length(recorded_device_id) <= 64),
  recorded_session_id UUID,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  PRIMARY KEY (id, occurred_at),
  CONSTRAINT mar_administrations_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT mar_administrations_order_fk FOREIGN KEY (hospital_id, order_id) REFERENCES treatment_orders (hospital_id, id),
  CONSTRAINT mar_administrations_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT mar_administrations_care_entry_fk FOREIGN KEY (hospital_id, care_entry_id) REFERENCES care_entries (hospital_id, id),
  CONSTRAINT mar_administrations_given CHECK ((state = 'given') = (quantity IS NOT NULL)),
  CONSTRAINT mar_administrations_reason CHECK (state = 'given' OR reason_code IS NOT NULL),
  CONSTRAINT mar_administrations_other_reason CHECK (reason_code IS DISTINCT FROM 'other' OR reason_text IS NOT NULL),
  CONSTRAINT mar_administrations_witness CHECK (
    (witness_status = 'witnessed') = (witnessed_at IS NOT NULL)
    AND (witnessed_by_user_id IS NULL OR witnessed_by_user_id IS DISTINCT FROM recorded_by_user_id)
    AND (witness_status = 'not_needed' OR state = 'given')
  ),
  CONSTRAINT mar_administrations_not_future CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  CONSTRAINT mar_administrations_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
) PARTITION BY RANGE (occurred_at);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS mar_administrations_client_key ON mar_administrations (hospital_id, client_id, occurred_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mar_administrations_admission_idx ON mar_administrations (admission_id, occurred_at) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mar_administrations_order_idx ON mar_administrations (order_id, occurred_at) WHERE voided_at IS NULL;
--> statement-breakpoint

-- The sweep's look for gives still waiting for a witness.
CREATE INDEX IF NOT EXISTS mar_administrations_awaiting_idx ON mar_administrations (recorded_at)
  WHERE witness_status = 'awaiting' AND voided_at IS NULL;
--> statement-breakpoint

SELECT public.ensure_monthly_partitions('mar_administrations', 1, 12);
--> statement-breakpoint

/*
 * A dose is struck out, never edited. While it waits for its witness, the witness may be recorded
 * (once), or the wait marked skipped; flags are only ever added.
 */
CREATE OR REPLACE FUNCTION public.mar_administrations_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  mutable text[] := ARRAY['witness_status', 'witnessed_by_user_id', 'witnessed_at', 'control_flags',
                          'voided_at', 'voided_by_user_id', 'void_reason', 'recorded_by_user_id'];
BEGIN
  IF (n - mutable) <> (o - mutable) THEN
    RAISE EXCEPTION 'A dose cannot be edited; strike it out and record it again' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF o->>'voided_at' IS NOT NULL AND (n->'voided_at' IS DISTINCT FROM o->'voided_at' OR n->'void_reason' IS DISTINCT FROM o->'void_reason') THEN
    RAISE EXCEPTION 'This dose is already struck out' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT (OLD.control_flags <@ NEW.control_flags) THEN
    RAISE EXCEPTION 'A flag on a dose cannot be removed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.witness_status IS DISTINCT FROM NEW.witness_status
     AND NOT (OLD.witness_status = 'awaiting' AND NEW.witness_status IN ('witnessed', 'skipped'))
     AND NOT (OLD.witness_status = 'skipped' AND NEW.witness_status = 'witnessed') THEN
    RAISE EXCEPTION 'A witness cannot be taken back' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.witnessed_at IS NOT NULL AND (NEW.witnessed_at IS DISTINCT FROM OLD.witnessed_at) THEN
    RAISE EXCEPTION 'This dose is already witnessed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mar_administrations_guard ON mar_administrations;
--> statement-breakpoint

CREATE TRIGGER mar_administrations_guard BEFORE UPDATE ON mar_administrations
  FOR EACH ROW EXECUTE FUNCTION public.mar_administrations_guard();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS witness_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  mar_id UUID NOT NULL,
  mar_occurred_at TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL DEFAULT 'give' CHECK (action IN ('give')),
  actor_user_id UUID NOT NULL REFERENCES users(id),
  -- 'ward_device': anyone eligible takes the tablet and enters their own PIN on it.
  -- 'approval': the person named here approves in their own signed-in session.
  method TEXT NOT NULL CHECK (method IN ('ward_device', 'approval')),
  device_id TEXT CHECK (char_length(device_id) <= 64),
  witness_user_id UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined', 'expired', 'withdrawn')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  decided_at TIMESTAMPTZ,
  decided_channel TEXT CHECK (decided_channel IN ('personal', 'ward_device')),
  decided_device_id TEXT CHECK (char_length(decided_device_id) <= 64),
  decided_session_id UUID,
  CONSTRAINT witness_requests_mar_fk FOREIGN KEY (mar_id, mar_occurred_at) REFERENCES mar_administrations (id, occurred_at),
  CONSTRAINT witness_requests_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT witness_requests_two_people CHECK (witness_user_id IS NULL OR witness_user_id <> actor_user_id),
  CONSTRAINT witness_requests_method CHECK (
    (method = 'approval' AND witness_user_id IS NOT NULL) OR (method = 'ward_device' AND device_id IS NOT NULL)
  ),
  CONSTRAINT witness_requests_approved CHECK (status <> 'approved' OR (witness_user_id IS NOT NULL AND decided_at IS NOT NULL)),
  CONSTRAINT witness_requests_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS witness_requests_tenant_key ON witness_requests (hospital_id, id);
--> statement-breakpoint

-- One open request per dose.
CREATE UNIQUE INDEX IF NOT EXISTS witness_requests_open_key ON witness_requests (mar_id) WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS witness_requests_witness_idx ON witness_requests (witness_user_id) WHERE status = 'pending';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS witness_requests_device_idx ON witness_requests (device_id) WHERE status = 'pending';
--> statement-breakpoint

/* A request is decided once: pending → approved / declined / expired / withdrawn, and nothing else changes. */
CREATE OR REPLACE FUNCTION public.witness_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable text[] := ARRAY['status', 'witness_user_id', 'decided_at', 'decided_channel', 'decided_device_id', 'decided_session_id', 'actor_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A witness request cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'pending' OR (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR (OLD.method = 'approval' AND NEW.witness_user_id IS DISTINCT FROM OLD.witness_user_id)
     OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id THEN
    RAISE EXCEPTION 'A witness request is decided once' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS witness_requests_guard ON witness_requests;
--> statement-breakpoint

CREATE TRIGGER witness_requests_guard BEFORE UPDATE OR DELETE ON witness_requests
  FOR EACH ROW EXECUTE FUNCTION public.witness_requests_guard();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS presence_proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL,
  bed_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id),
  method TEXT NOT NULL CHECK (method IN ('code', 'qr')),
  proved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  channel TEXT CHECK (channel IN ('personal', 'ward_device')),
  device_id TEXT CHECK (char_length(device_id) <= 64),
  session_id UUID,
  CONSTRAINT presence_proofs_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT presence_proofs_bed_fk FOREIGN KEY (hospital_id, bed_id) REFERENCES beds (hospital_id, id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS presence_proofs_tenant_key ON presence_proofs (hospital_id, id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS presence_proofs_recent_idx ON presence_proofs (admission_id, user_id, proved_at);
--> statement-breakpoint

/* ------------------------------------------------------------ evidence */

DROP TRIGGER IF EXISTS acct_capture ON treatment_orders;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON treatment_orders
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'treatment_order',
    'admission_id,kind,medicine_id,route,ordering_doctor_id,transcribed,countersigned_by_user_id,stopped_at',
    'entered_by_user_id',
    'ordered_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON mar_administrations;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON mar_administrations
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'mar_administration',
    'admission_id,order_id,medicine_id,state,quantity,reason_code,witness_status,witnessed_by_user_id,control_flags,care_entry_id',
    'recorded_by_user_id',
    'occurred_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON witness_requests;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON witness_requests
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'witness_request', 'admission_id,mar_id,method,witness_user_id,status', 'actor_user_id', 'requested_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON presence_proofs;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON presence_proofs
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture('presence_proof', 'admission_id,bed_id,method', 'user_id', 'proved_at');
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['treatment_orders', 'mar_administrations', 'witness_requests', 'presence_proofs'] LOOP
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
    -- All four say which medicine a patient is on: clinical (0028).
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('REVOKE DELETE, TRUNCATE ON treatment_orders, mar_administrations, witness_requests, presence_proofs FROM %I', app);
    EXECUTE format('REVOKE UPDATE ON presence_proofs FROM %I', app);
  END IF;
END
$outer$;
