-- 0049_due_engine.sql — IPD sheets plan, phase B3b: due times, the due board, time-critical alerts (§7.10).
--
-- Due times are computed, never stored ahead (owner preference: no per-day copies; settings apply live):
-- lib/domain/due.ts turns each line's timing — fixed clock times, or an interval from the last given dose
-- — into due instances with a two-sided window. Only what happened is written: each dose's due time and
-- whether it was on time, late or early (mar_administrations), each snooze, each escalation.
--
--   medicines              + time_critical, its own window (else the hospital's), when the flag changed
--   time_critical_signoffs the doctor's sign-off of the time-critical list and windows (D-TIMECRIT); alerts
--                          for time-critical lines run only while the list is signed off as it stands
--   treatment_orders       + timing (clock times or interval, first due, keep/shift after a late dose),
--                          and timed task lines (vitals, sugar checks, dressings, turning)
--   mar_administrations    + the due time a dose answers, on time / late / early, by how much, and why
--   due_snoozes            a time-critical alert put off: a reason, at most 30 minutes, twice per dose
--   due_escalations        L1 (window end + 15 min) to the ward in-charge, L2 (+ 45) to the doctor on call or
--                          the ordering doctor; one row per dose and level. In observe they are counted only.
--   on_call_assignments    who is on call when (the L2 target)
--   wards.in_charge_user_id  the L1 target
--   due_rollups_daily      on-time figures per ward and day, written by the worker (never polled live)
--   alert_ratings          the nurse's "too many / about right / too few" once per shift
--
-- Written for the runner v2: idempotent, expand-only. Rollback: the module's stage back to observe, or the
-- module off; the new columns and tables are unused by earlier code.

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS time_critical BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS tc_window_before_min SMALLINT CHECK (tc_window_before_min BETWEEN 5 AND 240);
--> statement-breakpoint

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS tc_window_after_min SMALLINT CHECK (tc_window_after_min BETWEEN 5 AND 240);
--> statement-breakpoint

ALTER TABLE medicines ADD COLUMN IF NOT EXISTS tc_changed_at TIMESTAMPTZ;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS time_critical_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  signed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  -- The signer's role and, for a doctor, which doctor (the plan: the hospital's doctor, with the pharmacist if any).
  signed_role TEXT NOT NULL CHECK (signed_role IN ('doctor', 'pharmacist', 'owner')),
  doctor_id UUID,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- What was signed: the list (medicine ids, names, windows) and the hospital's windows, as they stood.
  list JSONB NOT NULL CHECK (jsonb_typeof(list) = 'array'),
  windows JSONB NOT NULL CHECK (jsonb_typeof(windows) = 'object'),
  note TEXT CHECK (char_length(note) BETWEEN 1 AND 300),
  CONSTRAINT time_critical_signoffs_doctor_fk FOREIGN KEY (hospital_id, doctor_id) REFERENCES doctors (hospital_id, id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS time_critical_signoffs_latest_idx ON time_critical_signoffs (hospital_id, signed_at DESC);
--> statement-breakpoint

ALTER TABLE treatment_orders DROP CONSTRAINT IF EXISTS treatment_orders_kind_check;
--> statement-breakpoint

ALTER TABLE treatment_orders DROP CONSTRAINT IF EXISTS treatment_orders_kind_values;
--> statement-breakpoint

-- Widened to timed task lines; every existing row is a medicine or an instruction.
ALTER TABLE treatment_orders ADD CONSTRAINT treatment_orders_kind_values CHECK (kind IN ('medicine', 'instruction', 'task')) NOT VALID;
--> statement-breakpoint

ALTER TABLE treatment_orders VALIDATE CONSTRAINT treatment_orders_kind_values;
--> statement-breakpoint

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS timing_mode TEXT CHECK (timing_mode IN ('clock', 'interval', 'prn', 'once'));
--> statement-breakpoint

-- Minutes after midnight (hospital time), e.g. {480, 1200} for 08:00 and 20:00.
ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS clock_times SMALLINT[]
  CHECK (clock_times IS NULL OR (cardinality(clock_times) BETWEEN 1 AND 24 AND 0 <= ALL (clock_times) AND 1439 >= ALL (clock_times)));
--> statement-breakpoint

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS interval_min SMALLINT CHECK (interval_min BETWEEN 15 AND 10080);
--> statement-breakpoint

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS first_due_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS late_policy TEXT CHECK (late_policy IN ('keep', 'shift'));
--> statement-breakpoint

ALTER TABLE treatment_orders ADD COLUMN IF NOT EXISTS task_kind TEXT CHECK (task_kind IN ('vitals', 'bsl', 'dressing', 'reposition', 'other'));
--> statement-breakpoint

ALTER TABLE treatment_orders DROP CONSTRAINT IF EXISTS treatment_orders_timing;
--> statement-breakpoint

-- A line's timing is whole or absent (lines written before 0049 have none: shown, never due).
ALTER TABLE treatment_orders ADD CONSTRAINT treatment_orders_timing CHECK (
  (timing_mode IS NULL AND clock_times IS NULL AND interval_min IS NULL AND late_policy IS NULL)
  OR (timing_mode = 'clock' AND clock_times IS NOT NULL AND interval_min IS NULL AND late_policy IS NOT NULL)
  OR (timing_mode = 'interval' AND interval_min IS NOT NULL AND first_due_at IS NOT NULL AND clock_times IS NULL AND late_policy IS NOT NULL)
  OR (timing_mode = 'once' AND first_due_at IS NOT NULL AND clock_times IS NULL AND interval_min IS NULL)
  OR (timing_mode = 'prn' AND clock_times IS NULL AND interval_min IS NULL)
) NOT VALID;
--> statement-breakpoint

ALTER TABLE treatment_orders VALIDATE CONSTRAINT treatment_orders_timing;
--> statement-breakpoint

ALTER TABLE treatment_orders DROP CONSTRAINT IF EXISTS treatment_orders_task;
--> statement-breakpoint

ALTER TABLE treatment_orders ADD CONSTRAINT treatment_orders_task CHECK (
  (kind = 'task') = (task_kind IS NOT NULL) AND (kind <> 'task' OR timing_mode IN ('clock', 'interval'))
) NOT VALID;
--> statement-breakpoint

ALTER TABLE treatment_orders VALIDATE CONSTRAINT treatment_orders_task;
--> statement-breakpoint

-- The escalation sweep reads only live timed lines.
CREATE INDEX IF NOT EXISTS treatment_orders_timed_idx ON treatment_orders (hospital_id, admission_id)
  WHERE timing_mode IN ('clock', 'interval', 'once') AND stopped_at IS NULL AND voided_at IS NULL;
--> statement-breakpoint

ALTER TABLE mar_administrations ADD COLUMN IF NOT EXISTS due_at TIMESTAMPTZ;
--> statement-breakpoint

ALTER TABLE mar_administrations ADD COLUMN IF NOT EXISTS timing_status TEXT CHECK (timing_status IN ('on_time', 'late', 'early', 'unscheduled'));
--> statement-breakpoint

-- Minutes after (+) or before (−) the due time.
ALTER TABLE mar_administrations ADD COLUMN IF NOT EXISTS delay_min INTEGER CHECK (delay_min BETWEEN -2880 AND 2880);
--> statement-breakpoint

ALTER TABLE mar_administrations ADD COLUMN IF NOT EXISTS timing_reason TEXT CHECK (char_length(timing_reason) BETWEEN 1 AND 200);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS mar_administrations_due_idx ON mar_administrations (order_id, due_at) WHERE due_at IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS due_snoozes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  snoozed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  reason TEXT NOT NULL CHECK (char_length(reason) BETWEEN 2 AND 200),
  snoozed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  until TIMESTAMPTZ NOT NULL,
  CONSTRAINT due_snoozes_order_fk FOREIGN KEY (hospital_id, order_id) REFERENCES treatment_orders (hospital_id, id),
  CONSTRAINT due_snoozes_at_most_30 CHECK (until > snoozed_at AND until <= snoozed_at + interval '30 minutes')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS due_snoozes_order_idx ON due_snoozes (order_id, due_at);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS due_escalations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  ward_id UUID,
  order_id UUID NOT NULL,
  due_at TIMESTAMPTZ NOT NULL,
  level SMALLINT NOT NULL CHECK (level IN (1, 2)),
  -- 'observe': counted for the "would have fired" figure, shown to nobody.
  mode TEXT NOT NULL CHECK (mode IN ('observe', 'live')),
  target TEXT NOT NULL CHECK (target IN ('ward_in_charge', 'ward', 'on_call', 'ordering_doctor')),
  target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  raised_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT due_escalations_order_fk FOREIGN KEY (hospital_id, order_id) REFERENCES treatment_orders (hospital_id, id),
  CONSTRAINT due_escalations_admission_fk FOREIGN KEY (hospital_id, admission_id) REFERENCES admissions (hospital_id, id) ON DELETE CASCADE,
  CONSTRAINT due_escalations_ack CHECK ((acknowledged_at IS NULL) OR mode = 'live')
);
--> statement-breakpoint

-- One escalation per dose and level, however often the sweep runs.
CREATE UNIQUE INDEX IF NOT EXISTS due_escalations_once_key ON due_escalations (order_id, due_at, level);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS due_escalations_open_idx ON due_escalations (hospital_id, raised_at)
  WHERE mode = 'live' AND acknowledged_at IS NULL;
--> statement-breakpoint

/* An escalation is acknowledged once, by someone; nothing else about it changes. */
CREATE OR REPLACE FUNCTION public.due_escalations_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  mutable text[] := ARRAY['acknowledged_at', 'acknowledged_by_user_id', 'target_user_id'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'An escalation cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - mutable) <> (to_jsonb(OLD) - mutable)
     OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at IS DISTINCT FROM OLD.acknowledged_at)
     OR (OLD.target_user_id IS NOT NULL AND NEW.target_user_id IS NOT NULL AND NEW.target_user_id <> OLD.target_user_id) THEN
    RAISE EXCEPTION 'An escalation is acknowledged once and never changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS due_escalations_guard ON due_escalations;
--> statement-breakpoint

CREATE TRIGGER due_escalations_guard BEFORE UPDATE OR DELETE ON due_escalations
  FOR EACH ROW EXECUTE FUNCTION public.due_escalations_guard();
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS on_call_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  doctor_id UUID NOT NULL,
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at TIMESTAMPTZ,
  cancelled_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT on_call_assignments_doctor_fk FOREIGN KEY (hospital_id, doctor_id) REFERENCES doctors (hospital_id, id),
  CONSTRAINT on_call_assignments_branch_fk FOREIGN KEY (hospital_id, branch_id) REFERENCES branches (hospital_id, id),
  CONSTRAINT on_call_assignments_span CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '7 days')
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS on_call_assignments_now_idx ON on_call_assignments (hospital_id, branch_id, starts_at, ends_at)
  WHERE cancelled_at IS NULL;
--> statement-breakpoint

ALTER TABLE wards ADD COLUMN IF NOT EXISTS in_charge_user_id UUID;
--> statement-breakpoint

ALTER TABLE wards DROP CONSTRAINT IF EXISTS wards_in_charge_fk;
--> statement-breakpoint

ALTER TABLE wards ADD CONSTRAINT wards_in_charge_fk FOREIGN KEY (in_charge_user_id, hospital_id)
  REFERENCES staff_memberships (user_id, hospital_id) ON DELETE SET NULL NOT VALID;
--> statement-breakpoint

ALTER TABLE wards VALIDATE CONSTRAINT wards_in_charge_fk;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS due_rollups_daily (
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  ward_id UUID NOT NULL,
  day DATE NOT NULL,
  time_critical BOOLEAN NOT NULL,
  due INTEGER NOT NULL CHECK (due >= 0),
  on_time INTEGER NOT NULL CHECK (on_time >= 0),
  late INTEGER NOT NULL CHECK (late >= 0),
  early INTEGER NOT NULL CHECK (early >= 0),
  not_given INTEGER NOT NULL CHECK (not_given >= 0),
  missed INTEGER NOT NULL CHECK (missed >= 0),
  median_delay_min INTEGER,
  would_escalate INTEGER NOT NULL DEFAULT 0,
  escalated INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (hospital_id, ward_id, day, time_critical)
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS alert_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  ward_id UUID NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_day DATE NOT NULL,
  shift TEXT NOT NULL CHECK (shift IN ('morning', 'evening', 'night')),
  rating TEXT NOT NULL CHECK (rating IN ('too_many', 'about_right', 'too_few')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_ratings_ward_fk FOREIGN KEY (hospital_id, ward_id) REFERENCES wards (hospital_id, id)
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS alert_ratings_once_key ON alert_ratings (user_id, ward_id, shift_day, shift);
--> statement-breakpoint

/* ------------------------------------------------------------ evidence */

DROP TRIGGER IF EXISTS acct_capture ON time_critical_signoffs;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON time_critical_signoffs
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture('time_critical_signoff', 'signed_role,doctor_id', 'signed_by_user_id', 'signed_at');
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON due_snoozes;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON due_snoozes
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture('due_snooze', 'order_id,due_at,until', 'snoozed_by_user_id', 'snoozed_at');
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON due_escalations;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON due_escalations
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'due_escalation', 'admission_id,order_id,due_at,level,mode,target,target_user_id,acknowledged_by_user_id', '', 'raised_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON on_call_assignments;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON on_call_assignments
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture('on_call_assignment', 'doctor_id,starts_at,ends_at,cancelled_at', 'created_by_user_id', 'created_at');
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['time_critical_signoffs', 'due_snoozes', 'due_escalations', 'on_call_assignments', 'due_rollups_daily', 'alert_ratings'] LOOP
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

  -- Which dose of which patient was late: clinical.
  FOREACH t IN ARRAY ARRAY['due_snoozes', 'due_escalations'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS clinical_access ON %I', t);
    EXECUTE format(
      'CREATE POLICY clinical_access ON %I AS RESTRICTIVE FOR ALL
         USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access())',
      t
    );
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON time_critical_signoffs, due_snoozes, alert_ratings FROM %I', app);
    EXECUTE format('REVOKE DELETE, TRUNCATE ON due_escalations, on_call_assignments FROM %I', app);
    -- Written by the worker only.
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON due_rollups_daily FROM %I', app);
  END IF;
END
$outer$;
