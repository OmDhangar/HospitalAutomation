-- 0046_stock.sql — IPD sheets plan, phase B4a: count-first stock for risk-class medicines (§7.3).
--
-- Risk-class medicines only (NDPS ENDs, psychotropics, a few high-value items; the hospital picks):
-- where they are kept (stock_locations), in which batches (stock_batches), how they arrived
-- (purchase_receipts, against the supplier's invoice), moved (stock_transfers, two-sided: sent, then
-- received) and were counted (stock_counts, blind, by someone other than whoever moved them), and
-- every change to what a place holds (stock_ledger). Until the MAR exists (B3-min), what was used is
-- the figure the counter copies from the paper drug register ("used since last count"), posted as a
-- 'give' marked source 'manual_register'.
--
-- The ledger is append-only. stock_balances is kept by a trigger on the ledger, as the owner of the
-- table: the app role can read balances but never write them, so a balance cannot disagree with the
-- ledger, and can never go below zero (a CHECK refuses the movement instead).
--
-- Separation of duties in the database: an adjustment's approver is not its requester, a count's
-- approver is not its counter. Every table feeds the evidence log (0044). Not clinical: no patient
-- data. Written for the runner v2.

CREATE TABLE IF NOT EXISTS risk_classes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('ndps', 'psychotropic', 'high_value', 'other')),
  count_every TEXT NOT NULL DEFAULT 'daily' CHECK (count_every IN ('daily', 'weekly')),
  archived_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS risk_classes_tenant_key ON risk_classes (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS risk_classes_name_key ON risk_classes (hospital_id, lower(name));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS medicine_risk_classes (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL,
  risk_class_id UUID NOT NULL,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, medicine_id),
  CONSTRAINT medicine_risk_classes_medicine_fk FOREIGN KEY (hospital_id, medicine_id)
    REFERENCES medicines (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT medicine_risk_classes_class_fk FOREIGN KEY (hospital_id, risk_class_id)
    REFERENCES risk_classes (hospital_id, id) ON DELETE CASCADE
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  kind TEXT NOT NULL CHECK (kind IN ('main_store', 'ward_store', 'lab_store', 'crash_cart', 'other')),
  ward_id UUID,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_locations_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT stock_locations_ward_fk FOREIGN KEY (hospital_id, ward_id) REFERENCES wards (hospital_id, id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_tenant_key ON stock_locations (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_branch_key ON stock_locations (hospital_id, id, branch_id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_locations_name_key ON stock_locations (hospital_id, branch_id, lower(name));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL,
  batch_no TEXT NOT NULL CHECK (batch_no ~ '^[A-Za-z0-9][A-Za-z0-9/._-]{0,39}$'),
  expiry_date DATE NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_batches_medicine_fk FOREIGN KEY (hospital_id, medicine_id) REFERENCES medicines (hospital_id, id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_tenant_key ON stock_batches (hospital_id, id);
--> statement-breakpoint

-- Lets every movement name its medicine and be held to its batch's medicine by one foreign key.
CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_medicine_key ON stock_batches (hospital_id, id, medicine_id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_batches_number_key ON stock_batches (hospital_id, medicine_id, upper(batch_no));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  location_id UUID NOT NULL,
  supplier_name TEXT NOT NULL CHECK (char_length(supplier_name) BETWEEN 2 AND 120),
  invoice_no TEXT NOT NULL CHECK (char_length(invoice_no) BETWEEN 1 AND 40),
  invoice_date DATE NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT purchase_receipts_location_fk FOREIGN KEY (hospital_id, location_id, branch_id)
    REFERENCES stock_locations (hospital_id, id, branch_id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipts_tenant_key ON purchase_receipts (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS purchase_receipts_client_key ON purchase_receipts (hospital_id, client_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  from_location_id UUID NOT NULL,
  to_location_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'received')),
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ,
  received_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_transfers_from_fk FOREIGN KEY (hospital_id, from_location_id) REFERENCES stock_locations (hospital_id, id),
  CONSTRAINT stock_transfers_to_fk FOREIGN KEY (hospital_id, to_location_id) REFERENCES stock_locations (hospital_id, id),
  CONSTRAINT stock_transfers_two_places CHECK (from_location_id <> to_location_id),
  CONSTRAINT stock_transfers_received CHECK ((status = 'received') = (received_at IS NOT NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_tenant_key ON stock_transfers (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_transfers_client_key ON stock_transfers (hospital_id, client_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stock_transfers_in_transit_idx ON stock_transfers (hospital_id, to_location_id) WHERE status = 'in_transit';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_transfer_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  transfer_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  quantity_sent INTEGER NOT NULL CHECK (quantity_sent > 0),
  quantity_received INTEGER CHECK (quantity_received IS NULL OR quantity_received BETWEEN 0 AND quantity_sent),
  CONSTRAINT stock_transfer_lines_transfer_fk FOREIGN KEY (hospital_id, transfer_id) REFERENCES stock_transfers (hospital_id, id),
  CONSTRAINT stock_transfer_lines_batch_fk FOREIGN KEY (hospital_id, batch_id, medicine_id)
    REFERENCES stock_batches (hospital_id, id, medicine_id),
  CONSTRAINT stock_transfer_lines_one_batch UNIQUE (transfer_id, batch_id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_counts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  location_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'submitted', 'approved', 'cancelled')),
  counted_by_user_id UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  approved_by_user_id UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  -- Separation of duties, observed (plan §7.2): the counter moved stock in or out of this place since
  -- its last approved count. Refused instead when the module's stage is 'enforce'.
  counted_by_mover BOOLEAN NOT NULL DEFAULT false,
  -- Stock moved at this place between the start of the count and its submission: recount advised.
  moved_during_count BOOLEAN NOT NULL DEFAULT false,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT stock_counts_location_fk FOREIGN KEY (hospital_id, location_id, branch_id)
    REFERENCES stock_locations (hospital_id, id, branch_id),
  CONSTRAINT stock_counts_two_people CHECK (approved_by_user_id IS NULL OR approved_by_user_id <> counted_by_user_id),
  CONSTRAINT stock_counts_submitted CHECK ((status IN ('submitted', 'approved')) = (submitted_at IS NOT NULL)),
  CONSTRAINT stock_counts_approved CHECK ((status = 'approved') = (approved_at IS NOT NULL AND approved_by_user_id IS NOT NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_tenant_key ON stock_counts (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_client_key ON stock_counts (hospital_id, client_id);
--> statement-breakpoint

-- One count at a time per place.
CREATE UNIQUE INDEX IF NOT EXISTS stock_counts_open_key ON stock_counts (hospital_id, location_id)
  WHERE status IN ('counting', 'submitted');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stock_counts_location_idx ON stock_counts (hospital_id, location_id, started_at DESC);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_count_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  count_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  counted_qty INTEGER CHECK (counted_qty IS NULL OR counted_qty BETWEEN 0 AND 100000),
  -- Filled at submission, never shown to the counter before it (blind count).
  book_qty INTEGER CHECK (book_qty IS NULL OR book_qty >= 0),
  used_allocated INTEGER NOT NULL DEFAULT 0 CHECK (used_allocated >= 0),
  variance INTEGER,
  reason_code TEXT CHECK (reason_code IS NULL OR reason_code IN
    ('recount_confirmed', 'use_not_written', 'broken', 'expired_removed', 'move_not_recorded', 'unknown', 'other')),
  reason_text TEXT CHECK (reason_text IS NULL OR char_length(reason_text) BETWEEN 3 AND 200),
  explained_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT stock_count_lines_count_fk FOREIGN KEY (hospital_id, count_id) REFERENCES stock_counts (hospital_id, id),
  CONSTRAINT stock_count_lines_batch_fk FOREIGN KEY (hospital_id, batch_id, medicine_id)
    REFERENCES stock_batches (hospital_id, id, medicine_id),
  CONSTRAINT stock_count_lines_one_batch UNIQUE (count_id, batch_id)
);
--> statement-breakpoint

-- "Used since last count", copied from the paper drug register, per medicine (B4a until the MAR).
CREATE TABLE IF NOT EXISTS stock_count_manual_use (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  count_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  used_qty INTEGER NOT NULL CHECK (used_qty BETWEEN 0 AND 100000),
  PRIMARY KEY (count_id, medicine_id),
  CONSTRAINT stock_count_manual_use_count_fk FOREIGN KEY (hospital_id, count_id) REFERENCES stock_counts (hospital_id, id),
  CONSTRAINT stock_count_manual_use_medicine_fk FOREIGN KEY (hospital_id, medicine_id) REFERENCES medicines (hospital_id, id)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  location_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity <> 0 AND quantity BETWEEN -100000 AND 100000),
  reason_code TEXT NOT NULL CHECK (reason_code IN ('expired', 'damaged', 'returned_to_supplier', 'found', 'entry_error', 'other')),
  reason_text TEXT CHECK (reason_text IS NULL OR char_length(reason_text) BETWEEN 3 AND 200),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by_user_id UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  client_id UUID NOT NULL,
  CONSTRAINT stock_adjustments_location_fk FOREIGN KEY (hospital_id, location_id) REFERENCES stock_locations (hospital_id, id),
  CONSTRAINT stock_adjustments_batch_fk FOREIGN KEY (hospital_id, batch_id, medicine_id)
    REFERENCES stock_batches (hospital_id, id, medicine_id),
  CONSTRAINT stock_adjustments_two_people CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id),
  CONSTRAINT stock_adjustments_decided CHECK ((status = 'pending') = (decided_at IS NULL))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_adjustments_tenant_key ON stock_adjustments (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_adjustments_client_key ON stock_adjustments (hospital_id, client_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stock_adjustments_pending_idx ON stock_adjustments (hospital_id) WHERE status = 'pending';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  location_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('receive', 'transfer_out', 'transfer_in', 'give', 'waste', 'return', 'adjust', 'count_variance')),
  quantity INTEGER NOT NULL CHECK (quantity <> 0 AND quantity BETWEEN -100000 AND 100000),
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'manual_register')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  receipt_id UUID,
  transfer_id UUID,
  count_id UUID,
  adjustment_id UUID,
  -- One posting per source event (the MAR's doses in B4b): a retry finds it instead of posting twice.
  reference_key TEXT CHECK (reference_key IS NULL OR char_length(reference_key) <= 80),
  CONSTRAINT stock_ledger_location_fk FOREIGN KEY (hospital_id, location_id) REFERENCES stock_locations (hospital_id, id),
  CONSTRAINT stock_ledger_batch_fk FOREIGN KEY (hospital_id, batch_id, medicine_id)
    REFERENCES stock_batches (hospital_id, id, medicine_id),
  CONSTRAINT stock_ledger_receipt_fk FOREIGN KEY (hospital_id, receipt_id) REFERENCES purchase_receipts (hospital_id, id),
  CONSTRAINT stock_ledger_transfer_fk FOREIGN KEY (hospital_id, transfer_id) REFERENCES stock_transfers (hospital_id, id),
  CONSTRAINT stock_ledger_count_fk FOREIGN KEY (hospital_id, count_id) REFERENCES stock_counts (hospital_id, id),
  CONSTRAINT stock_ledger_adjustment_fk FOREIGN KEY (hospital_id, adjustment_id) REFERENCES stock_adjustments (hospital_id, id),
  -- In is in, out is out: the direction of each kind is fixed.
  CONSTRAINT stock_ledger_direction CHECK (
    (kind IN ('receive', 'transfer_in') AND quantity > 0)
    OR (kind IN ('transfer_out', 'give', 'waste', 'return') AND quantity < 0)
    OR kind IN ('adjust', 'count_variance')
  ),
  CONSTRAINT stock_ledger_has_source CHECK (num_nonnulls(receipt_id, transfer_id, count_id, adjustment_id, reference_key) >= 1)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS stock_ledger_reference_key ON stock_ledger (hospital_id, reference_key) WHERE reference_key IS NOT NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stock_ledger_location_idx ON stock_ledger (hospital_id, location_id, recorded_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS stock_ledger_medicine_idx ON stock_ledger (hospital_id, medicine_id, recorded_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS stock_balances (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  location_id UUID NOT NULL,
  batch_id UUID NOT NULL,
  medicine_id UUID NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, location_id, batch_id),
  CONSTRAINT stock_balances_location_fk FOREIGN KEY (hospital_id, location_id) REFERENCES stock_locations (hospital_id, id),
  CONSTRAINT stock_balances_batch_fk FOREIGN KEY (hospital_id, batch_id, medicine_id)
    REFERENCES stock_batches (hospital_id, id, medicine_id)
);
--> statement-breakpoint

/* ------------------------------------------------------------ guards */

/* The ledger moves the balance, as the table's owner: the app role cannot write balances itself. */
CREATE OR REPLACE FUNCTION public.stock_ledger_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Update first: an INSERT ... ON CONFLICT checks quantity >= 0 on the row it would insert (the bare
  -- movement) before it finds the existing balance, so every outgoing movement would be refused.
  UPDATE stock_balances
  SET quantity = quantity + NEW.quantity, updated_at = now()
  WHERE hospital_id = NEW.hospital_id AND location_id = NEW.location_id AND batch_id = NEW.batch_id;
  IF NOT FOUND THEN
    -- First stock of this batch here. An outgoing first movement fails the CHECK, as it should.
    INSERT INTO stock_balances (hospital_id, location_id, batch_id, medicine_id, quantity, updated_at)
    VALUES (NEW.hospital_id, NEW.location_id, NEW.batch_id, NEW.medicine_id, NEW.quantity, now())
    ON CONFLICT (hospital_id, location_id, batch_id)
    DO UPDATE SET quantity = stock_balances.quantity + EXCLUDED.quantity, updated_at = now();
  END IF;
  RETURN NULL;
END
$fn$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.stock_ledger_apply() FROM PUBLIC;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_ledger_apply ON stock_ledger;
--> statement-breakpoint

CREATE TRIGGER stock_ledger_apply AFTER INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.stock_ledger_apply();
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_ledger_append_only ON stock_ledger;
--> statement-breakpoint

CREATE TRIGGER stock_ledger_append_only BEFORE UPDATE OR DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS purchase_receipts_append_only ON purchase_receipts;
--> statement-breakpoint

CREATE TRIGGER purchase_receipts_append_only BEFORE UPDATE OR DELETE ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
--> statement-breakpoint

/*
 * Workflow rows move forward only: a transfer from in transit to received, a count from counting to
 * submitted to approved (or counting to cancelled), an adjustment from pending to decided. Who and
 * when, once set, stay. Nothing is deleted.
 */
CREATE OR REPLACE FUNCTION public.stock_forward_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  o jsonb;
  n jsonb;
  allowed boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  IF TG_TABLE_NAME = 'stock_transfers' THEN
    allowed := o->>'status' = 'in_transit' AND n->>'status' = 'received'
      AND (n - 'status' - 'received_at' - 'received_by_user_id') = (o - 'status' - 'received_at' - 'received_by_user_id');
  ELSIF TG_TABLE_NAME = 'stock_adjustments' THEN
    allowed := o->>'status' = 'pending' AND n->>'status' IN ('approved', 'rejected')
      AND (n - 'status' - 'decided_at' - 'decided_by_user_id') = (o - 'status' - 'decided_at' - 'decided_by_user_id');
  ELSIF TG_TABLE_NAME = 'stock_counts' THEN
    allowed := ((o->>'status' = 'counting' AND n->>'status' IN ('counting', 'submitted', 'cancelled'))
        OR (o->>'status' = 'submitted' AND n->>'status' = 'approved'))
      AND n->'counted_by_user_id' = o->'counted_by_user_id'
      AND n->'location_id' = o->'location_id'
      AND n->'started_at' = o->'started_at';
  ELSIF TG_TABLE_NAME = 'stock_transfer_lines' THEN
    allowed := o->>'quantity_received' IS NULL AND n->>'quantity_received' IS NOT NULL
      AND (n - 'quantity_received') = (o - 'quantity_received');
  END IF;
  IF NOT allowed THEN
    RAISE EXCEPTION '% cannot be changed that way', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_forward_only ON stock_transfers;
--> statement-breakpoint

CREATE TRIGGER stock_forward_only BEFORE UPDATE OR DELETE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.stock_forward_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_forward_only ON stock_transfer_lines;
--> statement-breakpoint

CREATE TRIGGER stock_forward_only BEFORE UPDATE OR DELETE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION public.stock_forward_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_forward_only ON stock_adjustments;
--> statement-breakpoint

CREATE TRIGGER stock_forward_only BEFORE UPDATE OR DELETE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.stock_forward_only();
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_forward_only ON stock_counts;
--> statement-breakpoint

CREATE TRIGGER stock_forward_only BEFORE UPDATE OR DELETE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.stock_forward_only();
--> statement-breakpoint

/* A count's lines and used figures change only while it is being counted, explained, or approved — never after. */
CREATE OR REPLACE FUNCTION public.stock_count_lines_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  parent text;
BEGIN
  SELECT status INTO parent FROM stock_counts
  WHERE id = (CASE WHEN TG_OP = 'DELETE' THEN to_jsonb(OLD) ELSE to_jsonb(NEW) END->>'count_id')::uuid;
  IF parent IN ('approved', 'cancelled') THEN
    RAISE EXCEPTION 'This count is closed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF parent = 'counting' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  -- Submitted: only the explanation of a difference may still be written, on a line.
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'stock_count_lines'
     AND (to_jsonb(NEW) - 'reason_code' - 'reason_text' - 'explained_by_user_id')
       = (to_jsonb(OLD) - 'reason_code' - 'reason_text' - 'explained_by_user_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A submitted count cannot be changed' USING ERRCODE = 'insufficient_privilege';
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_count_lines_guard ON stock_count_lines;
--> statement-breakpoint

CREATE TRIGGER stock_count_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION public.stock_count_lines_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS stock_count_lines_guard ON stock_count_manual_use;
--> statement-breakpoint

CREATE TRIGGER stock_count_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_count_manual_use
  FOR EACH ROW EXECUTE FUNCTION public.stock_count_lines_guard();
--> statement-breakpoint

/* ------------------------------------------------------------ evidence */

DROP TRIGGER IF EXISTS acct_capture ON stock_ledger;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_movement',
    'location_id,medicine_id,batch_id,kind,quantity,source,receipt_id,transfer_id,count_id,adjustment_id,occurred_at',
    'recorded_by_user_id',
    'occurred_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON purchase_receipts;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON purchase_receipts
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_receipt', 'location_id,invoice_no,invoice_date', 'received_by_user_id', 'received_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON stock_transfers;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_transfer', 'from_location_id,to_location_id,status,received_by_user_id', 'sent_by_user_id', 'sent_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON stock_transfer_lines;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON stock_transfer_lines
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_transfer_line', 'transfer_id,medicine_id,batch_id,quantity_sent,quantity_received', '', ''
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON stock_counts;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON stock_counts
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_count', 'location_id,status,approved_by_user_id,counted_by_mover,moved_during_count', 'counted_by_user_id', 'started_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON stock_count_lines;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON stock_count_lines
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_count_line', 'count_id,medicine_id,batch_id,counted_qty,book_qty,used_allocated,variance,reason_code', '', ''
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON stock_adjustments;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'stock_adjustment', 'location_id,medicine_id,batch_id,quantity,reason_code,status,decided_by_user_id', 'requested_by_user_id', 'requested_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'risk_classes', 'medicine_risk_classes', 'stock_locations', 'stock_batches', 'purchase_receipts',
    'stock_transfers', 'stock_transfer_lines', 'stock_counts', 'stock_count_lines', 'stock_count_manual_use',
    'stock_adjustments', 'stock_ledger', 'stock_balances'
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

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON stock_ledger, purchase_receipts FROM %I', app);
    -- Balances move only through the ledger's trigger.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON stock_balances FROM %I', app);
  END IF;
END
$outer$;
