-- Tenant isolation enforced by Postgres, not by application code.
--
-- Every tenant-scoped table gets a policy comparing its hospital_id to the
-- `app.hospital_id` setting that withTenant() sets per transaction. If a query
-- forgets its tenant filter, it returns no rows instead of another hospital's
-- patients.
--
-- The nullif() is load-bearing. current_setting(..., true) only returns NULL
-- while the setting has never been defined on that connection; once any
-- transaction has called set_config, it reverts to an empty string instead, and
-- ''::uuid raises rather than evaluating to NULL. On a pooled connection that
-- turns the first untenanted query after any tenanted one into a 500. Mapping
-- '' to NULL keeps the policy quietly fail-closed in both cases.
--
-- FORCE ROW LEVEL SECURITY makes the policies apply to the table owner too, so
-- the application role cannot quietly sidestep them by owning the schema. The
-- migration/worker role is expected to carry BYPASSRLS, which overrides FORCE
-- and is why that role must never serve a web request.

DO $outer$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
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
  END LOOP;
END
$outer$;
--> statement-breakpoint

-- The hospitals table is keyed on `id` rather than `hospital_id`.
ALTER TABLE "hospitals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "hospitals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "hospitals"
  USING (id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.hospital_id', true), '')::uuid);--> statement-breakpoint

-- Deliberately left without RLS:
--   users, sessions  - queried during login, before any tenant is known
--   plan_tiers       - the public rate card, identical for every tenant
--   jobs             - cross-tenant worker queue, only ever touched by the
--                      BYPASSRLS role
-- Access to these is controlled by application authorisation instead. Keep the
-- list short and justify any addition.

-- Queue and audit history is append-only: it exists to answer "who moved this
-- token and when", which is worthless if rows can be rewritten afterwards.
--
-- DELETE is intentionally still permitted. Erasure on request is a DPDP
-- obligation, and blocking it here would also break the ON DELETE CASCADE path
-- when a hospital is offboarded.
CREATE OR REPLACE FUNCTION reject_history_update() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only and cannot be updated', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$fn$ LANGUAGE plpgsql;--> statement-breakpoint

CREATE TRIGGER queue_events_append_only
  BEFORE UPDATE ON "queue_events"
  FOR EACH ROW EXECUTE FUNCTION reject_history_update();--> statement-breakpoint

CREATE TRIGGER audit_logs_append_only
  BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION reject_history_update();
