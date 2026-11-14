CREATE TABLE IF NOT EXISTS rx_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID REFERENCES branches(id) ON DELETE CASCADE,
  doctor_id UUID REFERENCES doctors(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'general',
  default_diagnosis TEXT,
  default_advice TEXT,
  default_follow_up_days INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rx_groups_tenant_key ON rx_groups (hospital_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rx_groups_doctor_idx ON rx_groups (hospital_id, doctor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rx_groups_category_idx ON rx_groups (hospital_id, category);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS rx_group_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  rx_group_id UUID NOT NULL REFERENCES rx_groups(id) ON DELETE CASCADE,
  medicine_id UUID NOT NULL REFERENCES medicines(id) ON DELETE CASCADE,
  medicine_name TEXT NOT NULL,
  dose TEXT NOT NULL,
  frequency TEXT NOT NULL,
  duration_days INTEGER,
  instructions TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS rx_group_items_tenant_key ON rx_group_items (hospital_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS rx_group_items_group_idx ON rx_group_items (hospital_id, rx_group_id, sort_order);
--> statement-breakpoint
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'rx_groups',
    'rx_group_items'
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
