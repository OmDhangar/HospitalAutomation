-- Discharge billing (IPD plan §3.4, tasks T2.1–T2.4).
--
--   1. Gap-free bill numbers. A final bill is a tax document; numbers must
--      run without holes per hospital per financial year. A Postgres
--      sequence would leave a hole on every rolled-back transaction, so the
--      counter is a row, incremented under a row lock inside the very
--      transaction that finalises the bill.
--
--   2. A discount needs a reason. Bill lines already carry discount_paise
--      (0026); a discount is applied by voiding the line and re-posting it
--      discounted, and the reason now lives on the line itself.
--
--   3. The running bill the family can open during the stay: a link with a
--      128-bit token, stored hashed on the admission, expiring 7 days after
--      discharge. Payers moved to 0032 (decision D-AD).

CREATE TABLE document_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  -- What is numbered, e.g. 'ipd_bill'. A text, not an enum: a new document
  -- type should not need a migration of its own.
  kind TEXT NOT NULL CHECK (char_length(kind) BETWEEN 1 AND 40),
  -- "2026-27": numbering restarts each Indian financial year (April–March).
  fiscal_year TEXT NOT NULL CHECK (fiscal_year ~ '^\d{4}-\d{2}$'),
  last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX document_sequences_key ON document_sequences (hospital_id, kind, fiscal_year);
--> statement-breakpoint

ALTER TABLE bill_items ADD COLUMN discount_reason TEXT;
--> statement-breakpoint
ALTER TABLE bill_items ADD CONSTRAINT bill_items_discount_reason
  CHECK (discount_paise = 0 OR discount_reason IS NOT NULL);
--> statement-breakpoint

ALTER TABLE admissions
  ADD COLUMN bill_link_token_hash TEXT,
  ADD COLUMN bill_link_created_at TIMESTAMPTZ,
  -- Null while the stay runs; set to discharge + 7 days at discharge.
  ADD COLUMN bill_link_expires_at TIMESTAMPTZ,
  ADD COLUMN bill_link_revoked_at TIMESTAMPTZ;
--> statement-breakpoint
CREATE UNIQUE INDEX admissions_bill_link_key ON admissions (bill_link_token_hash)
  WHERE bill_link_token_hash IS NOT NULL;
--> statement-breakpoint

DO $outer$
BEGIN
  ALTER TABLE document_sequences ENABLE ROW LEVEL SECURITY;
  ALTER TABLE document_sequences FORCE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON document_sequences
    USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
    WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
  CREATE POLICY read_only_write ON document_sequences AS RESTRICTIVE
    FOR ALL USING (true) WITH CHECK (NOT public.app_read_only());
  CREATE POLICY read_only_delete ON document_sequences AS RESTRICTIVE
    FOR DELETE USING (NOT public.app_read_only());
END
$outer$;
--> statement-breakpoint

-- Reopening a finalised bill (within a day, with a reason) cancels it — its
-- number stays used, so numbering stays gap-free — and posts its lines again
-- on a new draft. The old lines must be voided first, or the "bill each
-- source once" indexes would refuse the re-post. So a one-way void is now
-- allowed on a cancelled bill as well as a draft; adding a line still needs
-- a draft, and nothing else about a line can ever change.
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

  SELECT status INTO bill_state FROM bills WHERE id = NEW.bill_id FOR SHARE;
  IF bill_state = 'draft' OR (TG_OP = 'UPDATE' AND bill_state = 'cancelled') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'bill % is %; its items can no longer change',
    NEW.bill_id, coalesce(bill_state::text, 'missing')
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;
