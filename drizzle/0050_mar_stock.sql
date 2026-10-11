-- 0050_mar_stock.sql — IPD sheets plan, phase B4b: the treatment card posts to the stock ledger (§7.2, §7.3).
--
-- A risk-class dose given from the treatment card is taken off the ward's store, earliest expiry first,
-- in the same transaction as the dose (stock_ledger kind 'give', source 'mar', one reference key per
-- batch row, so a retried save can never take it twice). When the store does not hold enough, the dose
-- is still saved — care is never held up by the books — and marked stock_status 'short' until someone
-- takes it off a store by hand. A struck-out dose puts its stock back ('reversal', never an edit).
--
-- Waste (mar_wastes): a broken ampoule, the rest of an opened one, a dose drawn up and not given. It
-- needs a second person (D-WITNESS: all risk-class waste), through the same witness requests as a give,
-- and nothing is taken off stock until it is witnessed.
--
-- Once a ward's doses post from the treatment card, its counts stop asking for the paper register's
-- "used since last count" (B4a's manual figure); that is decided in the app from the modules in force,
-- so this file changes no count data. Expand-only; written for the runner v2.

/* ------------------------------------------------------------ the ledger takes doses */

ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_kind_check;
--> statement-breakpoint

ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_kind_values;
--> statement-breakpoint

ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_kind_values CHECK (kind IN (
  'receive', 'transfer_out', 'transfer_in', 'give', 'waste', 'return', 'adjust', 'count_variance', 'reversal'
)) NOT VALID;
--> statement-breakpoint

ALTER TABLE stock_ledger VALIDATE CONSTRAINT stock_ledger_kind_values;
--> statement-breakpoint

ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_source_check;
--> statement-breakpoint

ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_source_values;
--> statement-breakpoint

ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_source_values CHECK (source IN ('app', 'manual_register', 'mar')) NOT VALID;
--> statement-breakpoint

ALTER TABLE stock_ledger VALIDATE CONSTRAINT stock_ledger_source_values;
--> statement-breakpoint

-- A reversal puts back what a struck-out dose or waste took: always in, and always named by its reference.
ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_direction;
--> statement-breakpoint

ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_direction_v2;
--> statement-breakpoint

ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_direction_v2 CHECK (
  (kind IN ('receive', 'transfer_in') AND quantity > 0)
  OR (kind IN ('transfer_out', 'give', 'waste', 'return') AND quantity < 0)
  OR (kind = 'reversal' AND quantity > 0 AND reference_key IS NOT NULL)
  OR kind IN ('adjust', 'count_variance')
) NOT VALID;
--> statement-breakpoint

ALTER TABLE stock_ledger VALIDATE CONSTRAINT stock_ledger_direction_v2;
--> statement-breakpoint

-- Doses and wastes from the MAR always carry their reference: "mar:<dose id>:<n>", "waste:<id>:<n>".
ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS stock_ledger_mar_reference;
--> statement-breakpoint

ALTER TABLE stock_ledger ADD CONSTRAINT stock_ledger_mar_reference CHECK (source <> 'mar' OR reference_key IS NOT NULL) NOT VALID;
--> statement-breakpoint

ALTER TABLE stock_ledger VALIDATE CONSTRAINT stock_ledger_mar_reference;
--> statement-breakpoint

-- Finding a dose's rows to reverse it, and the store's reconciliation by time.
CREATE INDEX IF NOT EXISTS stock_ledger_reference_prefix_idx ON stock_ledger (hospital_id, reference_key text_pattern_ops)
  WHERE reference_key IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stock_ledger_occurred_idx ON stock_ledger (hospital_id, location_id, occurred_at);
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON stock_ledger;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_movement',
    'location_id,medicine_id,batch_id,kind,quantity,source,receipt_id,transfer_id,count_id,adjustment_id,reference_key,occurred_at',
    'recorded_by_user_id',
    'occurred_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------------ a dose knows where its stock came from */

-- Null: nothing to take off stock (not risk-class, 0 units, or stock not in use for this ward).
ALTER TABLE mar_administrations ADD COLUMN IF NOT EXISTS stock_status TEXT
  CHECK (stock_status IN ('posted', 'short', 'reversed'));
--> statement-breakpoint

-- The store it was taken from (no foreign key: the table is partitioned; the app checks the store).
ALTER TABLE mar_administrations ADD COLUMN IF NOT EXISTS stock_location_id UUID;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mar_administrations_stock_short_idx ON mar_administrations (hospital_id, recorded_at)
  WHERE stock_status = 'short' AND voided_at IS NULL;
--> statement-breakpoint

/*
 * As 0048, plus the stock state: short → posted (taken off a store by hand, which may name the store),
 * posted → reversed (struck out). Nothing else about a dose changes.
 */
CREATE OR REPLACE FUNCTION public.mar_administrations_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  o jsonb := to_jsonb(OLD);
  n jsonb := to_jsonb(NEW);
  mutable text[] := ARRAY['witness_status', 'witnessed_by_user_id', 'witnessed_at', 'control_flags',
                          'voided_at', 'voided_by_user_id', 'void_reason', 'recorded_by_user_id',
                          'stock_status', 'stock_location_id'];
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
  IF OLD.stock_status IS DISTINCT FROM NEW.stock_status
     AND NOT (OLD.stock_status = 'short' AND NEW.stock_status = 'posted')
     AND NOT (OLD.stock_status = 'posted' AND NEW.stock_status = 'reversed') THEN
    RAISE EXCEPTION 'The stock state of a dose only moves forward' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.stock_location_id IS DISTINCT FROM NEW.stock_location_id
     AND NOT (OLD.stock_status = 'short' AND NEW.stock_status = 'posted') THEN
    RAISE EXCEPTION 'The store a dose came from is set when it is taken off stock' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON mar_administrations;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON mar_administrations
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'mar_administration',
    'admission_id,order_id,medicine_id,state,quantity,reason_code,witness_status,witnessed_by_user_id,control_flags,care_entry_id,stock_status,stock_location_id',
    'recorded_by_user_id',
    'occurred_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------------ waste */

CREATE TABLE IF NOT EXISTS mar_wastes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  order_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  -- The dose it was left over from, if any.
  mar_id UUID,
  mar_occurred_at TIMESTAMPTZ,
  -- The store the wasted units come off (null when stock is not in use on the ward: then it is recorded and
  -- witnessed, and nothing comes off).
  location_id UUID,
  -- Whole units taken off stock (a broken ampoule: 1). 0 for the rest of an opened unit whose
  -- dose already took the unit off stock: then the amount says how much was discarded.
  units SMALLINT NOT NULL CHECK (units BETWEEN 0 AND 100),
  amount TEXT CHECK (char_length(amount) BETWEEN 1 AND 40),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('remainder', 'broken', 'dropped', 'contaminated', 'not_used', 'expired', 'other')),
  reason_text TEXT CHECK (char_length(reason_text) BETWEEN 1 AND 200),
  occurred_at TIMESTAMPTZ NOT NULL,
  witness_status TEXT NOT NULL DEFAULT 'awaiting' CHECK (witness_status IN ('awaiting', 'witnessed')),
  witnessed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  witnessed_at TIMESTAMPTZ,
  -- Set when witnessed (posted or short), for waste that takes units off stock; reversed if struck out after.
  stock_status TEXT CHECK (stock_status IN ('posted', 'short', 'reversed')),
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
  CONSTRAINT mar_wastes_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT mar_wastes_order_fk FOREIGN KEY (hospital_id, order_id) REFERENCES treatment_orders (hospital_id, id),
  CONSTRAINT mar_wastes_medicine_fk FOREIGN KEY (hospital_id, medicine_id) REFERENCES medicines (hospital_id, id),
  CONSTRAINT mar_wastes_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT mar_wastes_location_fk FOREIGN KEY (hospital_id, location_id) REFERENCES stock_locations (hospital_id, id),
  CONSTRAINT mar_wastes_dose_fk FOREIGN KEY (mar_id, mar_occurred_at) REFERENCES mar_administrations (id, occurred_at),
  CONSTRAINT mar_wastes_dose_pair CHECK ((mar_id IS NULL) = (mar_occurred_at IS NULL)),
  CONSTRAINT mar_wastes_what CHECK (units > 0 OR amount IS NOT NULL),
  CONSTRAINT mar_wastes_other_reason CHECK (reason_code <> 'other' OR reason_text IS NOT NULL),
  CONSTRAINT mar_wastes_witness CHECK (
    (witness_status = 'witnessed') = (witnessed_at IS NOT NULL AND witnessed_by_user_id IS NOT NULL)
    AND (witnessed_by_user_id IS NULL OR witnessed_by_user_id IS DISTINCT FROM recorded_by_user_id)
  ),
  CONSTRAINT mar_wastes_stock CHECK (stock_status IS NULL OR (units > 0 AND witness_status = 'witnessed' AND location_id IS NOT NULL)),
  CONSTRAINT mar_wastes_not_future CHECK (occurred_at <= recorded_at + interval '5 minutes'),
  CONSTRAINT mar_wastes_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS mar_wastes_tenant_key ON mar_wastes (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS mar_wastes_client_key ON mar_wastes (hospital_id, client_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mar_wastes_admission_idx ON mar_wastes (admission_id, occurred_at) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mar_wastes_awaiting_idx ON mar_wastes (hospital_id, recorded_at)
  WHERE witness_status = 'awaiting' AND voided_at IS NULL;
--> statement-breakpoint

/*
 * Waste is struck out, never edited: the witness is recorded once, the stock state moves forward
 * (posted/short when witnessed, short → posted by hand, posted → reversed when struck out after).
 */
CREATE OR REPLACE FUNCTION public.mar_wastes_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  o jsonb;
  n jsonb;
  mutable text[] := ARRAY['witness_status', 'witnessed_by_user_id', 'witnessed_at', 'stock_status', 'location_id',
                          'voided_at', 'voided_by_user_id', 'void_reason', 'recorded_by_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Waste is struck out, never deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  IF (n - mutable) <> (o - mutable) THEN
    RAISE EXCEPTION 'Waste cannot be edited; strike it out and record it again' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.voided_at IS NOT NULL AND (NEW.voided_at IS DISTINCT FROM OLD.voided_at OR NEW.void_reason IS DISTINCT FROM OLD.void_reason) THEN
    RAISE EXCEPTION 'This waste is already struck out' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.witness_status = 'witnessed' AND (NEW.witness_status <> 'witnessed'
       OR NEW.witnessed_at IS DISTINCT FROM OLD.witnessed_at OR NEW.witnessed_by_user_id IS DISTINCT FROM OLD.witnessed_by_user_id) THEN
    RAISE EXCEPTION 'A witness cannot be taken back' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.stock_status IS DISTINCT FROM NEW.stock_status
     AND NOT (OLD.stock_status IS NULL AND NEW.stock_status IN ('posted', 'short') AND NEW.witness_status = 'witnessed')
     AND NOT (OLD.stock_status = 'short' AND NEW.stock_status = 'posted')
     AND NOT (OLD.stock_status = 'posted' AND NEW.stock_status = 'reversed') THEN
    RAISE EXCEPTION 'The stock state of a waste only moves forward' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.location_id IS DISTINCT FROM NEW.location_id AND NOT (OLD.stock_status = 'short' AND NEW.stock_status = 'posted') THEN
    RAISE EXCEPTION 'The store of a waste is set when it is recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS mar_wastes_guard ON mar_wastes;
--> statement-breakpoint

CREATE TRIGGER mar_wastes_guard BEFORE UPDATE OR DELETE ON mar_wastes
  FOR EACH ROW EXECUTE FUNCTION public.mar_wastes_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON mar_wastes;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON mar_wastes
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'mar_waste',
    'admission_id,order_id,medicine_id,mar_id,location_id,units,reason_code,witness_status,witnessed_by_user_id,stock_status',
    'recorded_by_user_id',
    'occurred_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------------ witness requests cover waste */

ALTER TABLE witness_requests ALTER COLUMN mar_id DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE witness_requests ALTER COLUMN mar_occurred_at DROP NOT NULL;
--> statement-breakpoint

ALTER TABLE witness_requests ADD COLUMN IF NOT EXISTS waste_id UUID;
--> statement-breakpoint

ALTER TABLE witness_requests DROP CONSTRAINT IF EXISTS witness_requests_waste_fk;
--> statement-breakpoint

ALTER TABLE witness_requests ADD CONSTRAINT witness_requests_waste_fk FOREIGN KEY (hospital_id, waste_id)
  REFERENCES mar_wastes (hospital_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE witness_requests VALIDATE CONSTRAINT witness_requests_waste_fk;
--> statement-breakpoint

ALTER TABLE witness_requests DROP CONSTRAINT IF EXISTS witness_requests_action_check;
--> statement-breakpoint

ALTER TABLE witness_requests DROP CONSTRAINT IF EXISTS witness_requests_action_values;
--> statement-breakpoint

ALTER TABLE witness_requests ADD CONSTRAINT witness_requests_action_values CHECK (action IN ('give', 'waste')) NOT VALID;
--> statement-breakpoint

ALTER TABLE witness_requests VALIDATE CONSTRAINT witness_requests_action_values;
--> statement-breakpoint

-- A give request names its dose; a waste request names its waste; never both.
ALTER TABLE witness_requests DROP CONSTRAINT IF EXISTS witness_requests_subject;
--> statement-breakpoint

ALTER TABLE witness_requests ADD CONSTRAINT witness_requests_subject CHECK (
  (action = 'give' AND mar_id IS NOT NULL AND mar_occurred_at IS NOT NULL AND waste_id IS NULL)
  OR (action = 'waste' AND waste_id IS NOT NULL AND mar_id IS NULL AND mar_occurred_at IS NULL)
) NOT VALID;
--> statement-breakpoint

ALTER TABLE witness_requests VALIDATE CONSTRAINT witness_requests_subject;
--> statement-breakpoint

-- One open request per waste, as per dose.
CREATE UNIQUE INDEX IF NOT EXISTS witness_requests_open_waste_key ON witness_requests (waste_id) WHERE status = 'pending';
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON witness_requests;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON witness_requests
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'witness_request', 'admission_id,action,mar_id,waste_id,method,witness_user_id,status', 'actor_user_id', 'requested_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
BEGIN
  ALTER TABLE mar_wastes ENABLE ROW LEVEL SECURITY;
  ALTER TABLE mar_wastes FORCE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON mar_wastes;
  CREATE POLICY tenant_isolation ON mar_wastes
    USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
    WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
  DROP POLICY IF EXISTS read_only_write ON mar_wastes;
  CREATE POLICY read_only_write ON mar_wastes AS RESTRICTIVE FOR ALL USING (true) WITH CHECK (NOT public.app_read_only());
  DROP POLICY IF EXISTS read_only_delete ON mar_wastes;
  CREATE POLICY read_only_delete ON mar_wastes AS RESTRICTIVE FOR DELETE USING (NOT public.app_read_only());
  -- Says which medicine a patient is on: clinical (0028), as the doses.
  DROP POLICY IF EXISTS clinical_access ON mar_wastes;
  CREATE POLICY clinical_access ON mar_wastes AS RESTRICTIVE FOR ALL
    USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access());

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON mar_wastes TO %I', app);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON mar_wastes FROM %I', app);
  END IF;
END
$outer$;
