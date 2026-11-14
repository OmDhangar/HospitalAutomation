-- 0077_multi_tier_rate_plans.sql: Multi-Tier Tariff Rate Plans (Cash vs. TPA Insurance vs. Corporate)

CREATE TABLE IF NOT EXISTS rate_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  payer_kind payer_kind NOT NULL DEFAULT 'self',
  payer_name TEXT,
  modifier_bp INTEGER NOT NULL DEFAULT 0,
  is_default BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rate_plans_tenant_key ON rate_plans (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rate_plans_code_idx ON rate_plans (hospital_id, lower(code)) WHERE voided_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rate_plans_default_idx ON rate_plans (hospital_id) WHERE is_default IS TRUE AND voided_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS charge_item_tariffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  rate_plan_id UUID NOT NULL REFERENCES rate_plans(id) ON DELETE CASCADE,
  charge_item_id UUID NOT NULL REFERENCES charge_items(id) ON DELETE CASCADE,
  tariff_price_paise INTEGER NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS charge_item_tariffs_tenant_key ON charge_item_tariffs (hospital_id, id);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS charge_item_tariffs_unique_idx ON charge_item_tariffs (hospital_id, rate_plan_id, charge_item_id) WHERE voided_at IS NULL;
--> statement-breakpoint

ALTER TABLE encounter_payers ADD COLUMN IF NOT EXISTS rate_plan_id UUID REFERENCES rate_plans(id) ON DELETE SET NULL;
--> statement-breakpoint

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rate_plans',
    'charge_item_tariffs'
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
