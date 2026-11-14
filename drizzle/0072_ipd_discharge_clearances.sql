CREATE TABLE IF NOT EXISTS ipd_discharge_clearances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  admission_id UUID NOT NULL REFERENCES admissions(id) ON DELETE CASCADE,
  discharge_type TEXT NOT NULL DEFAULT 'regular',
  clinical_fit_at TIMESTAMPTZ,
  clinical_fit_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  clinical_stability_notes TEXT,
  pharmacy_returned_at TIMESTAMPTZ,
  pharmacy_returned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  pharmacy_credit_note_no TEXT,
  pharmacy_credit_amount_paise INTEGER DEFAULT 0,
  pharmacy_return_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  take_home_dispensed_at TIMESTAMPTZ,
  take_home_counseled BOOLEAN NOT NULL DEFAULT false,
  take_home_counseling_notes TEXT,
  nursing_cleared_at TIMESTAMPTZ,
  nursing_cleared_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  iv_cannula_removed BOOLEAN NOT NULL DEFAULT false,
  foley_catheter_removed BOOLEAN NOT NULL DEFAULT false,
  drains_removed BOOLEAN NOT NULL DEFAULT false,
  wound_dressing_done BOOLEAN NOT NULL DEFAULT false,
  belongings_and_reports_handed_over BOOLEAN NOT NULL DEFAULT false,
  discharge_vitals_taken BOOLEAN NOT NULL DEFAULT false,
  nursing_handover_notes TEXT,
  diagnostics_cleared_at TIMESTAMPTZ,
  diagnostics_cleared_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  diagnostics_notes TEXT,
  billing_cleared_at TIMESTAMPTZ,
  billing_cleared_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  gate_pass_number TEXT,
  gate_pass_issued_at TIMESTAMPTZ,
  gate_pass_issued_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS ipd_discharge_clearances_tenant_adm_idx
  ON ipd_discharge_clearances (hospital_id, admission_id);
--> statement-breakpoint
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ipd_discharge_clearances'
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
