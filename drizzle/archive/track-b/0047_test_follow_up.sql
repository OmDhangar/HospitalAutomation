-- 0047_test_follow_up.sql — IPD sheets plan, phase C4a: test orders and follow-up (Rev 5.1, §11.1 row 7a).
--
-- The doctor sends a patient for a test, in OPD or on the ward. Each test belongs to a service point
-- (a lab or a room, with its floor and section written in English, Marathi and Hindi so the staff can
-- guide the patient over the phone) and the service point has its assigned staff. When the patient has
-- not reached the service point in the hospital's set time — counted from the order, or from payment,
-- per service point (D-LABCLOCK) — a "not arrived" task is raised for that staff; if nobody calls
-- within 15 more minutes it is raised to the admin (D-LABFU). Calls only, no WhatsApp (D-LABMSG).
--
--   service_points         a lab or room; its directions in en/mr/hi; when its clock starts and how long it runs
--   service_point_staff    who works there (any staff member; removal is a stamp, not a delete)
--   charge_items           + service_point_id: where each test is done
--   test_orders            one test for one patient: ordered → arrived → done → report added,
--                          or closed as not coming (went home / refused) or cancelled
--   test_follow_up_calls   every call made to a patient who has not arrived, with its outcome
--
-- The clock and the escalation are stamped on the order by the sweep (task_raised_at, escalated_at),
-- so the evidence log shows when each was raised. Orders move forward only; calls are append-only.
-- test_orders and test_follow_up_calls are clinical (which test a patient needs). Every table feeds the
-- evidence log (0044). Written for the runner v2: idempotent and expand-only.
--
-- Rollback: switch the "Test follow-up" module off (nothing is shown or written; data is kept). The
-- tables and the new charge_items column are unused by earlier code, so the previous image runs on
-- this schema unchanged.

CREATE TABLE IF NOT EXISTS service_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lab' CHECK (kind IN ('lab', 'imaging', 'room', 'other')),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 2 AND 60),
  name_mr TEXT CHECK (char_length(name_mr) BETWEEN 1 AND 60),
  name_hi TEXT CHECK (char_length(name_hi) BETWEEN 1 AND 60),
  floor TEXT CHECK (char_length(floor) BETWEEN 1 AND 40),
  floor_mr TEXT CHECK (char_length(floor_mr) BETWEEN 1 AND 40),
  floor_hi TEXT CHECK (char_length(floor_hi) BETWEEN 1 AND 40),
  section TEXT CHECK (char_length(section) BETWEEN 1 AND 80),
  section_mr TEXT CHECK (char_length(section_mr) BETWEEN 1 AND 80),
  section_hi TEXT CHECK (char_length(section_hi) BETWEEN 1 AND 80),
  -- D-LABCLOCK: from the doctor's order (default) or from payment; 30 minutes unless the hospital says otherwise.
  clock_from TEXT NOT NULL DEFAULT 'order' CHECK (clock_from IN ('order', 'payment')),
  clock_minutes SMALLINT NOT NULL DEFAULT 30 CHECK (clock_minutes BETWEEN 5 AND 240),
  active BOOLEAN NOT NULL DEFAULT true,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT service_points_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS service_points_tenant_key ON service_points (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS service_points_name_key ON service_points (hospital_id, branch_id, lower(name));
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS service_point_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  service_point_id UUID NOT NULL,
  user_id UUID NOT NULL,
  assigned_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ,
  CONSTRAINT service_point_staff_point_fk FOREIGN KEY (hospital_id, service_point_id)
    REFERENCES service_points (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT service_point_staff_member_fk FOREIGN KEY (user_id, hospital_id)
    REFERENCES staff_memberships (user_id, hospital_id) ON DELETE CASCADE
);
--> statement-breakpoint

-- One live assignment per person per service point; history stays.
CREATE UNIQUE INDEX IF NOT EXISTS service_point_staff_live_key ON service_point_staff (service_point_id, user_id)
  WHERE removed_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS service_point_staff_user_idx ON service_point_staff (hospital_id, user_id)
  WHERE removed_at IS NULL;
--> statement-breakpoint

ALTER TABLE charge_items ADD COLUMN IF NOT EXISTS service_point_id UUID;
--> statement-breakpoint

ALTER TABLE charge_items DROP CONSTRAINT IF EXISTS charge_items_service_point_fk;
--> statement-breakpoint

-- Every existing row is null, so the check costs nothing; NOT VALID keeps the lock short all the same.
ALTER TABLE charge_items ADD CONSTRAINT charge_items_service_point_fk FOREIGN KEY (hospital_id, service_point_id)
  REFERENCES service_points (hospital_id, id) NOT VALID;
--> statement-breakpoint

ALTER TABLE charge_items VALIDATE CONSTRAINT charge_items_service_point_fk;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS test_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  setting TEXT NOT NULL CHECK (setting IN ('opd', 'ipd')),
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  admission_id UUID,
  charge_item_id UUID NOT NULL,
  -- The test's name when it was ordered: a later rename does not rewrite what the doctor asked for.
  test_name TEXT NOT NULL CHECK (char_length(test_name) BETWEEN 1 AND 120),
  service_point_id UUID NOT NULL,
  -- The OPD bill line (OPD) or the bedside entry that billed it (IPD).
  bill_item_id UUID REFERENCES bill_items(id) ON DELETE SET NULL,
  care_entry_id UUID,
  -- The service point's clock when the test was ordered: changing the setting later does not move a running clock.
  clock_from TEXT NOT NULL CHECK (clock_from IN ('order', 'payment')),
  clock_minutes SMALLINT NOT NULL CHECK (clock_minutes BETWEEN 5 AND 240),
  ordered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ordered_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  client_id UUID NOT NULL,
  paid_at TIMESTAMPTZ,
  -- When the "not arrived" task is due: ordered_at or paid_at, plus clock_minutes.
  due_at TIMESTAMPTZ,
  task_raised_at TIMESTAMPTZ,
  escalated_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'ordered'
    CHECK (status IN ('ordered', 'arrived', 'done', 'reported', 'not_coming', 'cancelled')),
  arrived_at TIMESTAMPTZ,
  arrived_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  done_at TIMESTAMPTZ,
  done_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reported_at TIMESTAMPTZ,
  reported_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_at TIMESTAMPTZ,
  closed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  closed_reason TEXT CHECK (closed_reason IN ('went_home', 'refused_cost', 'refused_fear', 'refused_other')),
  closed_note TEXT CHECK (char_length(closed_note) BETWEEN 1 AND 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT test_orders_encounter_fk FOREIGN KEY (hospital_id, encounter_id, patient_id)
    REFERENCES encounters (hospital_id, id, patient_id),
  CONSTRAINT test_orders_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT test_orders_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions (hospital_id, id),
  CONSTRAINT test_orders_item_fk FOREIGN KEY (hospital_id, charge_item_id) REFERENCES charge_items (hospital_id, id),
  CONSTRAINT test_orders_point_fk FOREIGN KEY (hospital_id, service_point_id) REFERENCES service_points (hospital_id, id),
  CONSTRAINT test_orders_care_entry_fk FOREIGN KEY (hospital_id, care_entry_id) REFERENCES care_entries (hospital_id, id),
  CONSTRAINT test_orders_setting CHECK ((setting = 'ipd') = (admission_id IS NOT NULL)),
  CONSTRAINT test_orders_clock CHECK (
    (clock_from = 'order' AND due_at IS NOT NULL)
    OR (clock_from = 'payment' AND (due_at IS NULL) = (paid_at IS NULL))
  ),
  CONSTRAINT test_orders_escalation CHECK (escalated_at IS NULL OR task_raised_at IS NOT NULL),
  CONSTRAINT test_orders_arrived CHECK ((arrived_at IS NOT NULL) = (status IN ('arrived', 'done', 'reported'))),
  CONSTRAINT test_orders_done CHECK ((done_at IS NOT NULL) = (status IN ('done', 'reported'))),
  CONSTRAINT test_orders_reported CHECK ((reported_at IS NOT NULL) = (status = 'reported')),
  CONSTRAINT test_orders_closed CHECK ((closed_at IS NOT NULL) = (status IN ('not_coming', 'cancelled'))),
  CONSTRAINT test_orders_closed_reason CHECK ((closed_reason IS NOT NULL) = (status = 'not_coming'))
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS test_orders_tenant_key ON test_orders (hospital_id, id);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS test_orders_client_key ON test_orders (hospital_id, client_id);
--> statement-breakpoint

-- An IPD test is ordered once per bedside entry, however often the doctor's form is retried.
CREATE UNIQUE INDEX IF NOT EXISTS test_orders_care_entry_key ON test_orders (care_entry_id) WHERE care_entry_id IS NOT NULL;
--> statement-breakpoint

-- The worklists: open orders of a service point, and the sweep's due tasks.
CREATE INDEX IF NOT EXISTS test_orders_open_idx ON test_orders (hospital_id, service_point_id, ordered_at)
  WHERE status IN ('ordered', 'arrived', 'done');
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS test_orders_due_idx ON test_orders (due_at)
  WHERE status = 'ordered' AND escalated_at IS NULL;
--> statement-breakpoint

-- The day screens (Today, day-end pending).
CREATE INDEX IF NOT EXISTS test_orders_day_idx ON test_orders (hospital_id, ordered_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS test_orders_encounter_idx ON test_orders (encounter_id) WHERE paid_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS test_follow_up_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  service_point_id UUID NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN (
    'no_answer', 'coming_now', 'told_the_way', 'will_come_later', 'went_home',
    'refused_cost', 'refused_fear', 'refused_other'
  )),
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 200),
  called_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  called_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- Was the person calling assigned to this service point at the time? (The admin may call too.)
  caller_assigned BOOLEAN NOT NULL,
  client_id UUID NOT NULL,
  CONSTRAINT test_follow_up_calls_order_fk FOREIGN KEY (hospital_id, order_id) REFERENCES test_orders (hospital_id, id),
  CONSTRAINT test_follow_up_calls_point_fk FOREIGN KEY (hospital_id, service_point_id) REFERENCES service_points (hospital_id, id),
  CONSTRAINT test_follow_up_calls_refused_note CHECK (outcome <> 'refused_other' OR note IS NOT NULL)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS test_follow_up_calls_client_key ON test_follow_up_calls (hospital_id, client_id, order_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS test_follow_up_calls_order_idx ON test_follow_up_calls (order_id, called_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS test_follow_up_calls_day_idx ON test_follow_up_calls (hospital_id, called_at);
--> statement-breakpoint

/* --------------------------------------------------------- forward only */

/*
 * An order moves forward and never back: ordered → arrived → done → reported, or ordered/arrived →
 * not coming or cancelled. What was ordered, for whom, when and by whom never changes; the payment
 * time, due time, task and escalation stamps are written once. Nothing is deleted.
 */
CREATE OR REPLACE FUNCTION public.test_orders_forward_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  o jsonb;
  n jsonb;
  mutable text[] := ARRAY[
    'status', 'paid_at', 'due_at', 'task_raised_at', 'escalated_at',
    'arrived_at', 'arrived_by_user_id', 'done_at', 'done_by_user_id', 'reported_at', 'reported_by_user_id',
    'closed_at', 'closed_by_user_id', 'closed_reason', 'closed_note', 'bill_item_id'
  ];
  k text;
  allowed boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A test order cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);

  -- Everything else is fixed at the order.
  IF (n - mutable) <> (o - mutable) THEN
    RAISE EXCEPTION 'What was ordered cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Set once, never cleared or moved. (bill_item_id may be cleared only by its own ON DELETE SET NULL.)
  FOREACH k IN ARRAY ARRAY[
    'paid_at', 'due_at', 'task_raised_at', 'escalated_at', 'arrived_at', 'arrived_by_user_id',
    'done_at', 'done_by_user_id', 'reported_at', 'reported_by_user_id', 'closed_at', 'closed_by_user_id',
    'closed_reason', 'closed_note'
  ] LOOP
    IF jsonb_typeof(o->k) IS DISTINCT FROM 'null' AND o ? k AND (n->k) IS DISTINCT FROM (o->k) THEN
      RAISE EXCEPTION '% is already set', k USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;

  allowed := o->>'status' = n->>'status'
    OR (o->>'status' = 'ordered' AND n->>'status' IN ('arrived', 'done', 'reported', 'not_coming', 'cancelled'))
    OR (o->>'status' = 'arrived' AND n->>'status' IN ('done', 'reported', 'not_coming', 'cancelled'))
    OR (o->>'status' = 'done' AND n->>'status' = 'reported');
  IF NOT allowed THEN
    RAISE EXCEPTION 'A test cannot go from % back to %', o->>'status', n->>'status' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS test_orders_forward_only ON test_orders;
--> statement-breakpoint

CREATE TRIGGER test_orders_forward_only BEFORE UPDATE OR DELETE ON test_orders
  FOR EACH ROW EXECUTE FUNCTION public.test_orders_forward_only();
--> statement-breakpoint

/* ------------------------------------------------------------ evidence */

DROP TRIGGER IF EXISTS acct_capture ON service_points;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON service_points
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'service_point', 'branch_id,kind,name,floor,section,clock_from,clock_minutes,active', 'created_by_user_id', 'created_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON service_point_staff;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON service_point_staff
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'service_point_staff', 'service_point_id,user_id,removed_at', 'assigned_by_user_id', 'assigned_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON test_orders;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON test_orders
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'test_order',
    'patient_id,setting,charge_item_id,service_point_id,clock_from,clock_minutes,status,paid_at,due_at,task_raised_at,escalated_at,closed_reason',
    'ordered_by_user_id',
    'ordered_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON test_follow_up_calls;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON test_follow_up_calls
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'test_call', 'order_id,service_point_id,outcome,caller_assigned', 'called_by_user_id', 'called_at'
  );
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['service_points', 'service_point_staff', 'test_orders', 'test_follow_up_calls'] LOOP
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

  -- Which test a patient needs is clinical: only transactions holding the clinical key see it (0028).
  FOREACH t IN ARRAY ARRAY['test_orders', 'test_follow_up_calls'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON service_points, service_point_staff, test_orders TO %I', app);
    EXECUTE format('GRANT SELECT, INSERT ON test_follow_up_calls TO %I', app);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON service_points, service_point_staff, test_orders FROM %I', app);
    -- A call, once recorded, is what happened.
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON test_follow_up_calls FROM %I', app);
  END IF;
END
$outer$;
