-- 0076_pharmacy_pos.sql: Outpatient Retail Pharmacy POS & Counter Dispensing

ALTER TABLE plan_tiers ADD COLUMN IF NOT EXISTS has_inhouse_pharmacy BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS has_inhouse_pharmacy BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS fulfillment_status TEXT NOT NULL DEFAULT 'unfulfilled';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pharmacy_sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  sale_no TEXT NOT NULL,
  sale_type TEXT NOT NULL,
  prescription_id UUID REFERENCES prescriptions(id) ON DELETE SET NULL,
  patient_id UUID REFERENCES patients(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT,
  doctor_name TEXT,
  payment_mode TEXT NOT NULL,
  subtotal_paise INTEGER NOT NULL,
  cgst_paise INTEGER NOT NULL DEFAULT 0,
  sgst_paise INTEGER NOT NULL DEFAULT 0,
  discount_paise INTEGER NOT NULL DEFAULT 0,
  total_paise INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  dispensed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  dispensed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_sales_tenant_sale_no_idx
  ON pharmacy_sales (hospital_id, sale_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pharmacy_sales_hospital_created_idx
  ON pharmacy_sales (hospital_id, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pharmacy_sales_prescription_idx
  ON pharmacy_sales (hospital_id, prescription_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pharmacy_sale_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  sale_id UUID NOT NULL REFERENCES pharmacy_sales(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id),
  batch_id UUID NOT NULL REFERENCES stock_batches(id),
  batch_no TEXT NOT NULL,
  expiry_date DATE NOT NULL,
  hsn_code TEXT,
  quantity INTEGER NOT NULL,
  unit_price_paise INTEGER NOT NULL,
  mrp_paise INTEGER NOT NULL,
  discount_percent SMALLINT NOT NULL DEFAULT 0,
  gst_rate SMALLINT NOT NULL DEFAULT 12,
  taxable_amount_paise INTEGER NOT NULL,
  cgst_amount_paise INTEGER NOT NULL DEFAULT 0,
  sgst_amount_paise INTEGER NOT NULL DEFAULT 0,
  total_amount_paise INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pharmacy_sale_items_sale_idx
  ON pharmacy_sale_items (sale_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pharmacy_sale_items_hospital_medicine_idx
  ON pharmacy_sale_items (hospital_id, medicine_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pharmacy_returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  return_no TEXT NOT NULL,
  sale_id UUID NOT NULL REFERENCES pharmacy_sales(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  refund_mode TEXT NOT NULL,
  refund_amount_paise INTEGER NOT NULL,
  returned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  returned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pharmacy_returns_tenant_return_no_idx
  ON pharmacy_returns (hospital_id, return_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pharmacy_returns_sale_idx
  ON pharmacy_returns (sale_id);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS pharmacy_return_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  return_id UUID NOT NULL REFERENCES pharmacy_returns(id) ON DELETE CASCADE,
  sale_item_id UUID NOT NULL REFERENCES pharmacy_sale_items(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL REFERENCES stock_batches(id),
  quantity_returned INTEGER NOT NULL,
  refund_amount_paise INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS pharmacy_return_items_return_idx
  ON pharmacy_return_items (return_id);
--> statement-breakpoint

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'pharmacy_sales',
    'pharmacy_sale_items',
    'pharmacy_returns',
    'pharmacy_return_items'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      $p$
        DROP POLICY IF EXISTS tenant_isolation ON %I;
        CREATE POLICY tenant_isolation ON %I
          USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
          WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
      $p$,
      t, t
    );
    EXECUTE format(
      $p$
        DROP POLICY IF EXISTS read_only_write ON %I;
        CREATE POLICY read_only_write ON %I AS RESTRICTIVE
          FOR ALL
          USING (true)
          WITH CHECK (NOT public.app_read_only())
      $p$,
      t, t
    );
    EXECUTE format(
      $p$
        DROP POLICY IF EXISTS read_only_delete ON %I;
        CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
          FOR DELETE
          USING (NOT public.app_read_only())
      $p$,
      t, t
    );
  END LOOP;
END
$outer$;
