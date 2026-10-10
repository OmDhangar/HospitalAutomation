-- 0043_charts.sql — IPD sheets plan, phase B1: the nursing T.P.R. chart.
--
-- chart_entries: one row is one line of the paper chart — a time, the vitals taken then, intake and
-- output, a note. Typed columns for the vitals every chart has (fast to query, and what the early
-- warning score and detectors read later); `extra` holds fields a hospital's own template adds
-- (lib/domain/tpr.ts names the template on each row).
--
-- Partitioned by month from the start (plan §9.4 rule 8): it is the fastest-growing clinical table.
-- ensure_monthly_partitions() creates the months needed; the sweep keeps twelve ahead. Each partition
-- has row-level security on with no policy, so it can only be reached through chart_entries, whose
-- policies apply.
--
-- Clinical (clinical_access), void-only like care_entries: a wrong reading is voided with a reason,
-- never edited. A retry from the phone's outbox carries the same client id and observed time, so it
-- finds the saved row instead of adding a second.
--
-- Written for the runner v2 (ADR-025): idempotent, expand-only.

CREATE TABLE IF NOT EXISTS chart_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL,
  admission_id UUID NOT NULL,
  encounter_id UUID NOT NULL,
  patient_id UUID NOT NULL,
  template_key TEXT NOT NULL DEFAULT 'general_tpr' CHECK (template_key ~ '^[a-z][a-z0-9_]{1,39}$'),
  template_version SMALLINT NOT NULL DEFAULT 1 CHECK (template_version > 0),
  observed_at TIMESTAMPTZ NOT NULL,
  pulse SMALLINT CHECK (pulse BETWEEN 20 AND 250),
  bp_systolic SMALLINT CHECK (bp_systolic BETWEEN 40 AND 300),
  bp_diastolic SMALLINT CHECK (bp_diastolic BETWEEN 20 AND 200),
  spo2 SMALLINT CHECK (spo2 BETWEEN 40 AND 100),
  -- °F × 10: 98.6 °F is 986.
  temp_f_tenths SMALLINT CHECK (temp_f_tenths BETWEEN 900 AND 1100),
  bsl_mg_dl SMALLINT CHECK (bsl_mg_dl BETWEEN 10 AND 900),
  resp_rate SMALLINT CHECK (resp_rate BETWEEN 4 AND 80),
  abd_girth_cm SMALLINT CHECK (abd_girth_cm BETWEEN 20 AND 250),
  on_oxygen BOOLEAN,
  consciousness TEXT CHECK (consciousness IN ('A', 'C', 'V', 'P', 'U')),
  urine_ml INTEGER CHECK (urine_ml BETWEEN 0 AND 5000),
  drain_ml INTEGER CHECK (drain_ml BETWEEN 0 AND 5000),
  rt_aspirate_ml INTEGER CHECK (rt_aspirate_ml BETWEEN 0 AND 5000),
  oral_ml INTEGER CHECK (oral_ml BETWEEN 0 AND 5000),
  iv_ml INTEGER CHECK (iv_ml BETWEEN 0 AND 5000),
  note TEXT CHECK (note IS NULL OR char_length(note) BETWEEN 1 AND 200),
  extra JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(extra) = 'object' AND octet_length(extra::text) < 4000),
  source TEXT NOT NULL DEFAULT 'chart' CHECK (source IN ('chart', 'doctor_note')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  recorded_channel TEXT CHECK (recorded_channel IS NULL OR recorded_channel IN ('personal', 'ward_device')),
  recorded_device_id TEXT CHECK (recorded_device_id IS NULL OR char_length(recorded_device_id) <= 64),
  recorded_session_id UUID,
  client_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  voided_at TIMESTAMPTZ,
  voided_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  void_reason TEXT,
  PRIMARY KEY (id, observed_at),
  CONSTRAINT chart_entries_admission_fk FOREIGN KEY (hospital_id, admission_id, encounter_id, patient_id)
    REFERENCES admissions (hospital_id, id, encounter_id, patient_id) ON DELETE CASCADE,
  CONSTRAINT chart_entries_branch_fk FOREIGN KEY (hospital_id, branch_id)
    REFERENCES branches (hospital_id, id),
  CONSTRAINT chart_entries_bp_pair CHECK (
    (bp_systolic IS NULL) = (bp_diastolic IS NULL) AND (bp_systolic IS NULL OR bp_systolic > bp_diastolic)
  ),
  CONSTRAINT chart_entries_has_value CHECK (
    num_nonnulls(pulse, bp_systolic, spo2, temp_f_tenths, bsl_mg_dl, resp_rate, abd_girth_cm, on_oxygen,
                 consciousness, urine_ml, drain_ml, rt_aspirate_ml, oral_ml, iv_ml, note) >= 1
    OR extra <> '{}'::jsonb
  ),
  CONSTRAINT chart_entries_not_future CHECK (observed_at <= recorded_at + interval '5 minutes'),
  CONSTRAINT chart_entries_void_reason CHECK ((voided_at IS NULL) = (void_reason IS NULL))
) PARTITION BY RANGE (observed_at);
--> statement-breakpoint

-- A retry carries the same client id and observed time (the outbox stores both).
CREATE UNIQUE INDEX IF NOT EXISTS chart_entries_client_key ON chart_entries (hospital_id, client_id, observed_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS chart_entries_admission_idx ON chart_entries (admission_id, observed_at) WHERE voided_at IS NULL;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS chart_entries_branch_idx ON chart_entries (hospital_id, branch_id, observed_at);
--> statement-breakpoint

DROP TRIGGER IF EXISTS chart_entries_void_only ON chart_entries;
--> statement-breakpoint

CREATE TRIGGER chart_entries_void_only
  BEFORE UPDATE ON chart_entries
  FOR EACH ROW EXECUTE FUNCTION void_only_guard('recorded_by_user_id', 'voided_by_user_id');
--> statement-breakpoint

/*
 * Monthly partitions of a table partitioned by a timestamptz range, from `months_back` months before
 * this one to `months_ahead` after. Idempotent. Each new partition gets row-level security with no
 * policy: reachable only through its parent.
 */
CREATE OR REPLACE FUNCTION public.ensure_monthly_partitions(parent text, months_back int, months_ahead int)
RETURNS int
LANGUAGE plpgsql
AS $fn$
DECLARE
  first_month date := (date_trunc('month', now()) - make_interval(months => months_back))::date;
  m int;
  month_start date;
  part text;
  created int := 0;
BEGIN
  FOR m IN 0 .. months_back + months_ahead LOOP
    month_start := (first_month + make_interval(months => m))::date;
    part := format('%s_%s', parent, to_char(month_start, 'YYYYMM'));
    IF to_regclass(part) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
        part, parent, month_start, (month_start + interval '1 month')::date
      );
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', part);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', part);
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$fn$;
--> statement-breakpoint

SELECT public.ensure_monthly_partitions('chart_entries', 1, 12);
--> statement-breakpoint

/* ---------------------------------------------------------------- tenancy */

DO $outer$
BEGIN
  ALTER TABLE chart_entries ENABLE ROW LEVEL SECURITY;
  ALTER TABLE chart_entries FORCE ROW LEVEL SECURITY;

  DROP POLICY IF EXISTS tenant_isolation ON chart_entries;
  CREATE POLICY tenant_isolation ON chart_entries
    USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
    WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);

  DROP POLICY IF EXISTS read_only_write ON chart_entries;
  CREATE POLICY read_only_write ON chart_entries AS RESTRICTIVE
    FOR ALL USING (true) WITH CHECK (NOT public.app_read_only());

  DROP POLICY IF EXISTS read_only_delete ON chart_entries;
  CREATE POLICY read_only_delete ON chart_entries AS RESTRICTIVE
    FOR DELETE USING (NOT public.app_read_only());

  DROP POLICY IF EXISTS clinical_access ON chart_entries;
  CREATE POLICY clinical_access ON chart_entries AS RESTRICTIVE
    FOR ALL USING (public.app_clinical_access()) WITH CHECK (public.app_clinical_access());
END
$outer$;
