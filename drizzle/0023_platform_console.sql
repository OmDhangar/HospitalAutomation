-- Platform operator console: support impersonation, forced password resets,
-- and a read-only mode that Postgres enforces rather than the application.

/* --------------------------------------------------------------- sessions */

-- Who opened this session on someone else's behalf. NULL on every ordinary
-- login, which is what makes an impersonated session identifiable at a glance
-- in the audit trail rather than indistinguishable from the customer's own.
ALTER TABLE sessions
  ADD COLUMN impersonated_by_user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Set on impersonated sessions. Read by app_read_only() below, so the flag is
-- not merely advisory: it is the value the policies test.
ALTER TABLE sessions
  ADD COLUMN read_only BOOLEAN NOT NULL DEFAULT FALSE;

-- Where "stop impersonating" returns the operator to. Kept on the row rather
-- than in a cookie so that closing the tab cannot strand them.
ALTER TABLE sessions
  ADD COLUMN return_hospital_id UUID REFERENCES hospitals(id) ON DELETE SET NULL;

CREATE INDEX sessions_impersonation_idx
  ON sessions (impersonated_by_user_id)
  WHERE impersonated_by_user_id IS NOT NULL;
--> statement-breakpoint

/* ------------------------------------------------------------------ users */

-- An operator-issued password is a temporary credential, not a chosen one.
-- The flag is what stops it from quietly becoming permanent.
ALTER TABLE users
  ADD COLUMN must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
--> statement-breakpoint

/* -------------------------------------------------------- read-only guard */

-- Whether the current transaction may write.
--
-- Deliberately fail-closed on the parse: an unrecognised value is treated as
-- read-only rather than as permission. The nullif() is for the same reason as
-- in the tenant policies — current_setting(..., true) yields '' rather than
-- NULL once any transaction on the pooled connection has set it, and
-- ''::boolean raises instead of evaluating to false.
CREATE OR REPLACE FUNCTION public.app_read_only()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('app.read_only', true), '')::boolean,
    false
  )
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION public.app_read_only() FROM PUBLIC;
--> statement-breakpoint

-- Restrictive policies AND with the tenant policy rather than replacing it, so
-- a read-only session is confined to its hospital *and* forbidden to write.
--
-- Two policies per table because RLS checks writes through different clauses:
-- INSERT and UPDATE are vetted by WITH CHECK, DELETE by USING. A single FOR ALL
-- policy cannot express both without also gating SELECT, which would make a
-- read-only session unable to read — the opposite of the point.
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hospitals',
    'branches',
    'staff_memberships',
    'doctors',
    'doctor_schedules',
    'doctor_schedule_exceptions',
    'patients',
    'appointments',
    'queue_events',
    'doctor_day_states',
    'notification_outbox',
    'idempotency_keys',
    'usage_records',
    'audit_logs'
  ]
  LOOP
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
--> statement-breakpoint

-- Tables added after the original RLS migration carry hospital_id too and are
-- covered by their own policies in 0006/0011/0019; they get the same guard.
DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'whatsapp_numbers',
    'whatsapp_integrations',
    'whatsapp_conversations',
    'payments',
    'subscriptions'
  ]
  LOOP
    -- Skipped rather than failed when a table is absent, so this migration does
    -- not depend on the order optional features were adopted in.
    IF to_regclass(t) IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'read_only_write'
    ) THEN
      EXECUTE format(
        $p$
          CREATE POLICY read_only_write ON %I AS RESTRICTIVE
            FOR ALL
            USING (true)
            WITH CHECK (NOT public.app_read_only())
        $p$,
        t
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public' AND tablename = t AND policyname = 'read_only_delete'
    ) THEN
      EXECUTE format(
        $p$
          CREATE POLICY read_only_delete ON %I AS RESTRICTIVE
            FOR DELETE
            USING (NOT public.app_read_only())
        $p$,
        t
      );
    END IF;
  END LOOP;
END
$outer$;
--> statement-breakpoint

/* ------------------------------------------- entitlement snapshot repair */

-- Subscriptions opened between 0021 and this migration carry no entitlements.
--
-- `startSubscription` snapshotted the volume allowances but not the three
-- limits or the five feature flags, and because every one of those columns is
-- nullable or defaulted the omission produced a row that parsed fine and meant
-- "unlimited". Every term opened in that window has therefore been unrestricted
-- regardless of what was sold, and no plan limit has ever been enforced on one.
--
-- Running terms only, for the same reason 0021 restricted itself to them: a
-- superseded row records an agreement that has already closed, and rewriting it
-- would change history rather than describe it.
UPDATE subscriptions s SET
  max_branches = t.max_branches,
  max_doctors = t.max_doctors,
  max_staff_logins = t.max_staff_logins,
  has_display_board = t.has_display_board,
  has_owner_report = t.has_owner_report,
  has_advanced_reports = t.has_advanced_reports,
  has_data_export = t.has_data_export,
  has_audit_log = t.has_audit_log,
  support_tier = t.support_tier
FROM plan_tiers t
WHERE t.code = s.plan_tier_code
  AND s.superseded_at IS NULL
  AND s.ends_at > now()
  -- Only rows that were never given limits. A hospital on a negotiated
  -- allowance has had these edited by hand, and that is a commercial decision
  -- this repair must not quietly undo.
  AND s.max_branches IS NULL
  AND s.max_doctors IS NULL
  AND s.max_staff_logins IS NULL;
