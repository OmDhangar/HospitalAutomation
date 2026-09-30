-- The patient-side billing foundation: encounters, the hospital's price list,
-- bills, bill items and payments.
--
-- Four rules shape everything below:
--
--   1. An encounter is one episode of care. It POINTS AT an appointment; the
--      appointment never learns about it. The queue is untouched.
--   2. A price lives in configuration (`services`, later `medicines`). A bill
--      item COPIES the price it was charged at, so a later price change can
--      never rewrite an old bill.
--   3. Clinical completion and financial settlement are separate state
--      machines. An appointment can be COMPLETED while its bill is unpaid.
--   4. Money that has been recorded is corrected by an explicit void, never
--      edited or deleted. Triggers enforce it, because a rule that lives only
--      in application code is skipped by the first hand-written UPDATE.
--
-- Foreign keys between the new tables carry hospital_id, e.g.
-- (hospital_id, encounter_id) -> encounters(hospital_id, id). Foreign-key checks
-- ignore row-level security, so a single-column key would let a row in one
-- hospital point at another hospital's encounter. The composite key makes that
-- a constraint violation rather than something every service must remember.
--
-- Keys that protect history (a doctor, a service) are NO ACTION rather than
-- RESTRICT. Both stop a referenced row being deleted on its own; NO ACTION is
-- checked at the end of the statement, so offboarding a whole hospital —
-- which cascades through every table in no guaranteed order — still works.

/* ------------------------------------------------------------------ enums */

CREATE TYPE encounter_stage AS ENUM ('opd', 'ipd');
--> statement-breakpoint
CREATE TYPE encounter_status AS ENUM ('open', 'closed', 'cancelled');
--> statement-breakpoint
CREATE TYPE encounter_origin AS ENUM ('queue', 'emergency', 'direct');
--> statement-breakpoint
-- Only what is built. Procedures, room and nursing are added with the screens
-- that charge them; ALTER TYPE ... ADD VALUE is a one-line migration.
CREATE TYPE service_kind AS ENUM ('consultation');
--> statement-breakpoint
CREATE TYPE bill_status AS ENUM ('draft', 'final', 'cancelled');
--> statement-breakpoint
-- 'medicine' is declared now so the type is defined once, but the CHECK on
-- bill_items refuses it until the medicine catalogue exists.
CREATE TYPE bill_item_type AS ENUM ('consultation', 'medicine', 'other');
--> statement-breakpoint
CREATE TYPE patient_payment_kind AS ENUM ('payment', 'refund');
--> statement-breakpoint
CREATE TYPE patient_payment_method AS ENUM ('cash', 'upi', 'card', 'bank', 'other');
--> statement-breakpoint

/* --------------------------------------------------------------- services */

-- What the hospital charges for things that are not medicines. Today: one
-- consultation fee per doctor.
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  kind service_kind NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  doctor_id UUID REFERENCES doctors(id),
  -- "Selling price", not "price": a later module may add cost or MRP beside it
  -- without changing what this column means.
  selling_price_paise INTEGER NOT NULL CHECK (selling_price_paise >= 0),
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX services_tenant_key ON services (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX services_doctor_consultation_key
  ON services (hospital_id, doctor_id)
  WHERE kind = 'consultation';
--> statement-breakpoint

/* ------------------------------------------------------------- encounters */

CREATE TABLE encounters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id),
  patient_id UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- Null for an emergency or direct admission, which never had a token.
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  attending_doctor_id UUID NOT NULL REFERENCES doctors(id),
  origin encounter_origin NOT NULL,
  stage encounter_stage NOT NULL DEFAULT 'opd',
  status encounter_status NOT NULL DEFAULT 'open',
  opened_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT encounters_closed_at CHECK ((status = 'open') = (closed_at IS NULL))
);
--> statement-breakpoint
-- Target of the composite keys below: same hospital AND same patient.
CREATE UNIQUE INDEX encounters_tenant_patient_key ON encounters (hospital_id, id, patient_id);
--> statement-breakpoint
-- One encounter per appointment, so opening it twice (two tabs, a retry) is
-- an insert that does nothing rather than a duplicate record.
CREATE UNIQUE INDEX encounters_appointment_key ON encounters (appointment_id)
  WHERE appointment_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX encounters_patient_idx ON encounters (patient_id, opened_at);
--> statement-breakpoint
CREATE INDEX encounters_open_idx ON encounters (hospital_id, branch_id, stage)
  WHERE status = 'open';
--> statement-breakpoint

/* ------------------------------------------------------------------ bills */

-- A draft bill is the running (interim) bill. Finalising writes the number,
-- the totals and a snapshot of the patient, after which it is frozen; a
-- correction is a cancellation plus a new bill, never an edit.
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  status bill_status NOT NULL DEFAULT 'draft',
  bill_number TEXT,
  fiscal_year TEXT,
  subtotal_paise INTEGER,
  discount_paise INTEGER,
  tax_paise INTEGER,
  total_paise INTEGER,
  patient_name TEXT,
  patient_phone TEXT,
  patient_address TEXT,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  finalized_at TIMESTAMPTZ,
  finalized_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  cancel_reason TEXT,
  supersedes_bill_id UUID REFERENCES bills(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bills_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE,
  CONSTRAINT bills_draft_unnumbered CHECK (
    status <> 'draft' OR (bill_number IS NULL AND finalized_at IS NULL AND total_paise IS NULL)
  ),
  CONSTRAINT bills_final_complete CHECK (
    status <> 'final' OR (bill_number IS NOT NULL AND finalized_at IS NOT NULL AND total_paise IS NOT NULL)
  ),
  CONSTRAINT bills_cancel_stamped CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX bills_tenant_key ON bills (hospital_id, id);
--> statement-breakpoint
-- At most one running bill per encounter: every charge lands on the same one.
CREATE UNIQUE INDEX bills_one_draft_key ON bills (encounter_id) WHERE status = 'draft';
--> statement-breakpoint
CREATE UNIQUE INDEX bills_number_key ON bills (hospital_id, bill_number)
  WHERE bill_number IS NOT NULL;
--> statement-breakpoint
CREATE INDEX bills_encounter_idx ON bills (encounter_id);
--> statement-breakpoint

/* ------------------------------------------------------------- bill items */

-- One chargeable line. Every money column is computed by the server
-- (lib/domain/patient-billing.ts) and stored; the CHECKs are the backstop that
-- makes inconsistent arithmetic unstorable by any code path.
--
-- Sources are typed nullable columns rather than (source_type, source_id):
-- Postgres then guarantees the source exists, and each source gets its own
-- "bill this at most once" index. A new source is one column and one index.
CREATE TABLE bill_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  bill_id UUID NOT NULL,
  item_type bill_item_type NOT NULL,
  service_id UUID,
  -- The visit this consultation fee is for. NO ACTION rather than SET NULL:
  -- a nulling update would be refused by the freeze trigger below.
  appointment_id UUID REFERENCES appointments(id),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- The catalogue price at the moment of billing; null for a free-form line.
  configured_unit_price_paise INTEGER CHECK (configured_unit_price_paise >= 0),
  -- What was actually charged.
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  price_override_reason TEXT,
  subtotal_paise INTEGER NOT NULL,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  tax_rate_bp INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bp BETWEEN 0 AND 10000),
  tax_paise INTEGER NOT NULL DEFAULT 0 CHECK (tax_paise >= 0),
  total_paise INTEGER NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT bill_items_bill_fk FOREIGN KEY (hospital_id, bill_id)
    REFERENCES bills (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT bill_items_service_fk FOREIGN KEY (hospital_id, service_id)
    REFERENCES services (hospital_id, id),
  CONSTRAINT bill_items_source CHECK (
    (item_type = 'consultation' AND service_id IS NOT NULL)
    OR (item_type = 'other' AND service_id IS NULL AND appointment_id IS NULL)
  ),
  CONSTRAINT bill_items_override CHECK (
    configured_unit_price_paise IS NULL
    OR unit_price_paise = configured_unit_price_paise
    OR price_override_reason IS NOT NULL
  ),
  CONSTRAINT bill_items_math CHECK (
    subtotal_paise = quantity * unit_price_paise
    AND discount_paise BETWEEN 0 AND subtotal_paise
    AND total_paise = subtotal_paise - discount_paise + tax_paise
  ),
  CONSTRAINT bill_items_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint
CREATE INDEX bill_items_bill_idx ON bill_items (bill_id) WHERE voided_at IS NULL;
--> statement-breakpoint
-- A consultation is charged at most once, however many times Paid is tapped.
CREATE UNIQUE INDEX bill_items_consultation_once ON bill_items (appointment_id)
  WHERE appointment_id IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint

/* -------------------------------------------------------------- payments */

-- Money in, per encounter. Deposits are simply payments taken before a bill
-- is final, which is why this hangs off the encounter and not the bill.
-- Not called `payments`: that table is the hospital paying us.
CREATE TABLE patient_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  bill_id UUID,
  kind patient_payment_kind NOT NULL DEFAULT 'payment',
  -- Always positive; the direction comes from `kind`.
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  method patient_payment_method NOT NULL DEFAULT 'cash',
  reference TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  CONSTRAINT patient_payments_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id) ON DELETE CASCADE,
  CONSTRAINT patient_payments_bill_fk FOREIGN KEY (hospital_id, bill_id)
    REFERENCES bills (hospital_id, id),
  CONSTRAINT patient_payments_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
);
--> statement-breakpoint
CREATE INDEX patient_payments_encounter_idx ON patient_payments (encounter_id)
  WHERE voided_at IS NULL;
--> statement-breakpoint

/* ------------------------------------------------------------- integrity */

-- True when two versions of a row differ only in `cols`, and each of those
-- either kept its value or became null. That is exactly the footprint of
-- ON DELETE SET NULL when a staff account is removed — the one change a frozen
-- financial row must still accept.
CREATE OR REPLACE FUNCTION only_user_refs_cleared(old_row JSONB, new_row JSONB, cols TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT (old_row - cols) = (new_row - cols)
     AND NOT EXISTS (
       SELECT 1
       FROM unnest(cols) AS c
       WHERE new_row -> c <> 'null'::jsonb
         AND new_row -> c IS DISTINCT FROM old_row -> c
     )
$$;
--> statement-breakpoint

-- A one-way void: only the void columns change, and only from not-void.
CREATE OR REPLACE FUNCTION is_one_way_void(old_row JSONB, new_row JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT old_row ->> 'voided_at' IS NULL
     AND new_row ->> 'voided_at' IS NOT NULL
     AND (old_row - ARRAY['voided_at', 'voided_by_user_id', 'void_reason'])
       = (new_row - ARRAY['voided_at', 'voided_by_user_id', 'void_reason'])
$$;
--> statement-breakpoint

-- Items are added and voided only while their bill is a draft, and never
-- otherwise edited. DELETE is not guarded: erasure on request and hospital
-- offboarding both cascade through here, as with queue_events.
CREATE OR REPLACE FUNCTION bill_items_guard() RETURNS trigger AS $fn$
DECLARE
  bill_state bill_status;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF only_user_refs_cleared(to_jsonb(OLD), to_jsonb(NEW),
                              ARRAY['created_by_user_id', 'voided_by_user_id']) THEN
      RETURN NEW;
    END IF;
    IF NOT is_one_way_void(to_jsonb(OLD), to_jsonb(NEW)) THEN
      RAISE EXCEPTION 'bill_items may only be voided, never edited'
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;

  -- FOR SHARE waits out a concurrent finalisation, so an item cannot slip
  -- onto a bill in the instant it is being frozen.
  SELECT status INTO bill_state FROM bills WHERE id = NEW.bill_id FOR SHARE;
  IF bill_state IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'bill % is %; its items can no longer change',
      NEW.bill_id, coalesce(bill_state::text, 'missing')
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bill_items_guard
  BEFORE INSERT OR UPDATE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION bill_items_guard();
--> statement-breakpoint

-- A draft is a working document. A final bill may only be cancelled; a
-- cancelled bill may not change at all.
CREATE OR REPLACE FUNCTION bills_guard() RETURNS trigger AS $fn$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF only_user_refs_cleared(to_jsonb(OLD), to_jsonb(NEW),
       ARRAY['created_by_user_id', 'finalized_by_user_id', 'cancelled_by_user_id']) THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'final'
     AND NEW.status = 'cancelled'
     AND (to_jsonb(OLD) - ARRAY['status', 'cancelled_at', 'cancelled_by_user_id', 'cancel_reason', 'updated_at'])
       = (to_jsonb(NEW) - ARRAY['status', 'cancelled_at', 'cancelled_by_user_id', 'cancel_reason', 'updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bill % is % and cannot be changed', OLD.id, OLD.status
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER bills_guard
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION bills_guard();
--> statement-breakpoint

-- A payment is money that changed hands. It can be voided with a reason; it
-- cannot be edited into a different amount.
CREATE OR REPLACE FUNCTION patient_payments_guard() RETURNS trigger AS $fn$
BEGIN
  IF only_user_refs_cleared(to_jsonb(OLD), to_jsonb(NEW),
                            ARRAY['received_by_user_id', 'voided_by_user_id'])
     OR is_one_way_void(to_jsonb(OLD), to_jsonb(NEW)) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'patient_payments may only be voided, never edited'
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER patient_payments_guard
  BEFORE UPDATE ON patient_payments
  FOR EACH ROW EXECUTE FUNCTION patient_payments_guard();
--> statement-breakpoint

/* --------------------------------------------------------------- tenancy */

-- Identical to every other tenant table (0001, 0023): tenant isolation that
-- applies to the owner too, plus the read-only guard for support sessions.
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'services',
    'encounters',
    'bills',
    'bill_items',
    'patient_payments'
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
END
$outer$;
