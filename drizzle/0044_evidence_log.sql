-- 0044_evidence_log.sql — IPD sheets plan, phase A6-min: the evidence log (plan §7.6).
--
-- acct_events: one row for every write that matters — a reading charted or struck through, a
-- bedside item, a bill line, an admission or bed change, a patient record opened, every audited
-- action (sign-in, PIN, switch user, settings) — with who, when, from which channel, device and
-- session. Ids and numbers only: no names, notes or reasons (those stay in their own tables).
--
-- How rows get here: AFTER triggers on the source tables (acct_capture, acct_capture_audit), so a
-- write cannot happen without its event, whichever code path makes it. The app may also insert
-- directly (views of the Accountability page). Nothing may update or delete a row: a trigger
-- refuses it for everyone, and the app role has no UPDATE or DELETE privilege.
--
-- Tamper evidence: a BEFORE INSERT trigger gives each row its place (seq) and a SHA-256 hash of
-- its fields. Every hour the worker seals each hospital's new rows into acct_digests: a Merkle
-- root over the row hashes, chained to the previous digest, signed with the evidence key and
-- written to the anchor store. Changing, adding or removing a sealed row breaks the root or the
-- chain, and the verifier (lib/services/evidence.ts, scripts/verify-evidence.ts) says which.
--
-- Sealing must never miss a row that commits late. Every insert holds a shared advisory lock for
-- its hospital until commit; the sealer takes the same lock exclusively for an instant, reads the
-- highest seq, and lets go. Any row it could not see was given its seq after that instant.
--
-- No foreign keys: the evidence must outlive any row it describes, the hospital included.
-- Monthly partitions on recorded_at, like chart_entries (0043). Written for the runner v2.

CREATE SEQUENCE IF NOT EXISTS public.acct_events_seq AS bigint;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS acct_events (
  seq BIGINT NOT NULL,
  hospital_id UUID NOT NULL,
  branch_id UUID,
  occurred_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id UUID,
  witness_user_id UUID,
  channel TEXT CHECK (channel IS NULL OR char_length(channel) BETWEEN 1 AND 20),
  device_id TEXT CHECK (device_id IS NULL OR char_length(device_id) BETWEEN 1 AND 64),
  session_id UUID,
  action TEXT NOT NULL CHECK (char_length(action) BETWEEN 3 AND 120),
  object_type TEXT NOT NULL CHECK (char_length(object_type) BETWEEN 1 AND 60),
  object_id TEXT CHECK (object_id IS NULL OR char_length(object_id) <= 200),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) < 4000),
  row_hash BYTEA NOT NULL CHECK (octet_length(row_hash) = 32),
  PRIMARY KEY (seq, recorded_at)
) PARTITION BY RANGE (recorded_at);
--> statement-breakpoint

-- Sealing and the Accountability page: one hospital's rows in order.
CREATE INDEX IF NOT EXISTS acct_events_hospital_seq_idx ON acct_events (hospital_id, seq);
--> statement-breakpoint

-- One staff member's activity (plan §4.3, "accountability by person").
CREATE INDEX IF NOT EXISTS acct_events_actor_idx ON acct_events (hospital_id, actor_user_id, seq);
--> statement-breakpoint

/*
 * The text a row's hash is taken over. Version-tagged; lib/domain/evidence.ts builds the same
 * string from the raw columns, so the verifier does not have to trust this function.
 */
CREATE OR REPLACE FUNCTION public.acct_event_canonical(
  seq bigint, hospital_id uuid, branch_id uuid, occurred_at timestamptz, recorded_at timestamptz,
  actor_user_id uuid, witness_user_id uuid, channel text, device_id text, session_id uuid,
  action text, object_type text, object_id text, payload jsonb
)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT concat_ws(
    chr(31),
    'v1',
    seq::text,
    hospital_id::text,
    coalesce(branch_id::text, ''),
    ((extract(epoch FROM occurred_at) * 1000000)::bigint)::text,
    ((extract(epoch FROM recorded_at) * 1000000)::bigint)::text,
    coalesce(actor_user_id::text, ''),
    coalesce(witness_user_id::text, ''),
    coalesce(channel, ''),
    coalesce(device_id, ''),
    coalesce(session_id::text, ''),
    action,
    object_type,
    coalesce(object_id, ''),
    payload::text
  )
$fn$;
--> statement-breakpoint

/* Gives a new row its seq and hash. The shared lock is held to commit; see the header. */
CREATE OR REPLACE FUNCTION public.acct_events_seal()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(4242, hashtext(NEW.hospital_id::text));
  NEW.seq := nextval('public.acct_events_seq');
  NEW.row_hash := sha256(
    '\x00'::bytea || convert_to(
      public.acct_event_canonical(
        NEW.seq, NEW.hospital_id, NEW.branch_id, NEW.occurred_at, NEW.recorded_at,
        NEW.actor_user_id, NEW.witness_user_id, NEW.channel, NEW.device_id, NEW.session_id,
        NEW.action, NEW.object_type, NEW.object_id, NEW.payload
      ),
      'UTF8'
    )
  );
  RETURN NEW;
END
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.acct_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only: rows cannot be changed or removed', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_events_seal ON acct_events;
--> statement-breakpoint

CREATE TRIGGER acct_events_seal BEFORE INSERT ON acct_events
  FOR EACH ROW EXECUTE FUNCTION public.acct_events_seal();
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_events_append_only ON acct_events;
--> statement-breakpoint

CREATE TRIGGER acct_events_append_only BEFORE UPDATE OR DELETE ON acct_events
  FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
--> statement-breakpoint

SELECT public.ensure_monthly_partitions('acct_events', 1, 12);
--> statement-breakpoint

/* ------------------------------------------------------------- capture */

/* A setting the app writes per transaction (lib/db/index.ts), read safely: a bad value is null, never an error. */
CREATE OR REPLACE FUNCTION public.acct_setting(name text)
RETURNS text
LANGUAGE sql
STABLE
AS $fn$
  SELECT nullif(left(current_setting(name, true), 64), '')
$fn$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.acct_uuid(value text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT CASE WHEN value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN value::uuid END
$fn$;
--> statement-breakpoint

/*
 * One event per insert, void, or change of a listed column, on any table that carries
 * hospital_id. Arguments: object type; the columns copied into the payload (ids, numbers, codes —
 * never free text); the column naming who made the row; the column saying when it happened.
 */
CREATE OR REPLACE FUNCTION public.acct_capture()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  object_type text := TG_ARGV[0];
  cols text[] := string_to_array(TG_ARGV[1], ',');
  r jsonb := to_jsonb(NEW);
  o jsonb;
  act text;
  actor uuid;
  occurred timestamptz := now();
  chan text;
  device text;
  sess uuid;
BEGIN
  IF r->>'hospital_id' IS NULL THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'INSERT' THEN
    act := object_type || '.created';
    actor := public.acct_uuid(r->>TG_ARGV[2]);
    IF TG_ARGV[3] <> '' AND r->>TG_ARGV[3] IS NOT NULL THEN
      occurred := (r->>TG_ARGV[3])::timestamptz;
    END IF;
    -- Rows that carry their own channel and device (0042, 0043) are believed first.
    chan := coalesce(r->>'recorded_channel', r->>'channel');
    device := coalesce(r->>'recorded_device_id', r->>'device_id');
    sess := public.acct_uuid(coalesce(r->>'recorded_session_id', r->>'session_id'));
  ELSE
    o := to_jsonb(OLD);
    IF (o ? 'voided_at') AND o->>'voided_at' IS NULL AND r->>'voided_at' IS NOT NULL THEN
      act := object_type || '.voided';
      actor := public.acct_uuid(r->>'voided_by_user_id');
    ELSIF EXISTS (SELECT 1 FROM unnest(cols) AS c WHERE (r->c) IS DISTINCT FROM (o->c)) THEN
      act := object_type || '.changed';
    ELSE
      RETURN NULL;
    END IF;
  END IF;

  INSERT INTO acct_events (
    hospital_id, branch_id, occurred_at, actor_user_id, channel, device_id, session_id,
    action, object_type, object_id, payload
  ) VALUES (
    (r->>'hospital_id')::uuid,
    public.acct_uuid(r->>'branch_id'),
    occurred,
    coalesce(actor, public.acct_uuid(public.acct_setting('app.staff_user_id'))),
    left(coalesce(chan, public.acct_setting('app.channel')), 20),
    left(coalesce(device, public.acct_setting('app.device_id')), 64),
    coalesce(sess, public.acct_uuid(public.acct_setting('app.session_id'))),
    act,
    object_type,
    r->>'id',
    coalesce(
      (SELECT jsonb_object_agg(c, r->c) FROM unnest(cols) AS c WHERE r ? c AND jsonb_typeof(r->c) <> 'null'),
      '{}'::jsonb
    )
  );
  RETURN NULL;
END
$fn$;
--> statement-breakpoint

/* Every audited action with a hospital becomes an event; its metadata (reasons, old values) stays in audit_logs. */
CREATE OR REPLACE FUNCTION public.acct_capture_audit()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.hospital_id IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO acct_events (
    hospital_id, occurred_at, actor_user_id, channel, device_id, session_id,
    action, object_type, object_id, payload
  ) VALUES (
    NEW.hospital_id,
    NEW.created_at,
    NEW.actor_user_id,
    public.acct_setting('app.channel'),
    public.acct_setting('app.device_id'),
    public.acct_uuid(public.acct_setting('app.session_id')),
    left(NEW.action, 120),
    left(coalesce(nullif(NEW.object_type, ''), 'audit'), 60),
    left(NEW.object_id, 200),
    jsonb_build_object('audit_id', NEW.id)
  );
  RETURN NULL;
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON chart_entries;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON chart_entries
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'chart_entry',
    'admission_id,patient_id,observed_at,pulse,bp_systolic,bp_diastolic,spo2,temp_f_tenths,bsl_mg_dl,resp_rate,abd_girth_cm,on_oxygen,consciousness,urine_ml,drain_ml,rt_aspirate_ml,oral_ml,iv_ml,template_key,template_version,source,client_id',
    'recorded_by_user_id',
    'observed_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON care_entries;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON care_entries
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'care_entry',
    'admission_id,patient_id,medicine_id,charge_item_id,quantity,occurred_at,client_id',
    'recorded_by_user_id',
    'occurred_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON bill_items;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON bill_items
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'bill_item',
    'bill_id,item_type,medicine_id,charge_item_id,care_entry_id,bed_assignment_id,service_date,quantity,unit_price_paise,discount_paise,total_paise',
    'created_by_user_id',
    ''
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON admissions;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON admissions
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'admission',
    'patient_id,encounter_id,admitting_doctor_id,status,ipd_number',
    'requested_by_user_id',
    ''
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON bed_assignments;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT OR UPDATE ON bed_assignments
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'bed_assignment',
    'admission_id,bed_id,from_at,to_at',
    'assigned_by_user_id',
    'from_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON record_access_logs;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON record_access_logs
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'record_access',
    'action,patient_id,encounter_id',
    'actor_user_id',
    'created_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON policy_acknowledgements;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON policy_acknowledgements
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture(
    'policy_acknowledgement',
    'policy_key,policy_version,locale',
    'user_id',
    'acknowledged_at'
  );
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_capture ON audit_logs;
--> statement-breakpoint

CREATE TRIGGER acct_capture AFTER INSERT ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION public.acct_capture_audit();
--> statement-breakpoint

/* ------------------------------------------------------------- digests */

CREATE TABLE IF NOT EXISTS acct_digests (
  hospital_id UUID NOT NULL,
  digest_no BIGINT NOT NULL CHECK (digest_no > 0),
  -- The rows sealed: hospital_id's events with seq_from < seq <= seq_to.
  seq_from BIGINT NOT NULL CHECK (seq_from >= 0),
  seq_to BIGINT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count > 0),
  first_recorded_at TIMESTAMPTZ NOT NULL,
  last_recorded_at TIMESTAMPTZ NOT NULL,
  merkle_root BYTEA NOT NULL CHECK (octet_length(merkle_root) = 32),
  prev_hash BYTEA NOT NULL CHECK (octet_length(prev_hash) = 32),
  digest_hash BYTEA NOT NULL CHECK (octet_length(digest_hash) = 32),
  -- Ed25519 over digest_hash; null while no evidence key is configured.
  signature BYTEA CHECK (signature IS NULL OR octet_length(signature) = 64),
  key_id TEXT CHECK (key_id IS NULL OR key_id ~ '^[0-9a-f]{16}$'),
  sealed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  anchored_at TIMESTAMPTZ,
  anchor_ref TEXT CHECK (anchor_ref IS NULL OR char_length(anchor_ref) <= 300),
  PRIMARY KEY (hospital_id, digest_no),
  CONSTRAINT acct_digests_range CHECK (seq_to > seq_from),
  CONSTRAINT acct_digests_signed CHECK ((signature IS NULL) = (key_id IS NULL)),
  CONSTRAINT acct_digests_anchor CHECK ((anchored_at IS NULL) = (anchor_ref IS NULL))
);
--> statement-breakpoint

/* A digest is never changed, except that its anchor is recorded once. */
CREATE OR REPLACE FUNCTION public.acct_digests_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.anchored_at IS NULL
     AND (to_jsonb(NEW) - 'anchored_at' - 'anchor_ref') = (to_jsonb(OLD) - 'anchored_at' - 'anchor_ref') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'acct_digests is append-only: only the anchor may be recorded, once'
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_digests_guard ON acct_digests;
--> statement-breakpoint

CREATE TRIGGER acct_digests_guard BEFORE UPDATE OR DELETE ON acct_digests
  FOR EACH ROW EXECUTE FUNCTION public.acct_digests_guard();
--> statement-breakpoint

/* Each run of the verifier and what it found: the Accountability page shows the last one. */
CREATE TABLE IF NOT EXISTS acct_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id UUID NOT NULL,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ran_by_user_id UUID,
  source TEXT NOT NULL CHECK (source IN ('sweep', 'manual', 'cli')),
  ok BOOLEAN NOT NULL,
  from_digest BIGINT,
  to_digest BIGINT,
  digests_checked INTEGER NOT NULL CHECK (digests_checked >= 0),
  events_checked INTEGER NOT NULL CHECK (events_checked >= 0),
  -- Codes and digest numbers only.
  problems JSONB NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(problems) = 'array' AND octet_length(problems::text) < 8000)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS acct_verifications_hospital_idx ON acct_verifications (hospital_id, ran_at DESC);
--> statement-breakpoint

DROP TRIGGER IF EXISTS acct_verifications_append_only ON acct_verifications;
--> statement-breakpoint

CREATE TRIGGER acct_verifications_append_only BEFORE UPDATE OR DELETE ON acct_verifications
  FOR EACH ROW EXECUTE FUNCTION public.acct_append_only();
--> statement-breakpoint

/* ------------------------------------------------------- tenancy, privileges */

DO $outer$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['acct_events', 'acct_digests', 'acct_verifications'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I
         USING (hospital_id = nullif(current_setting(''app.hospital_id'', true), '''')::uuid)
         WITH CHECK (hospital_id = nullif(current_setting(''app.hospital_id'', true), '''')::uuid)',
      t
    );
  END LOOP;

  -- Payloads carry vitals: reading the log needs the clinical key. Writing does not, so that a
  -- sign-in, a settings change or a support session's read is never refused its event.
  DROP POLICY IF EXISTS clinical_read ON acct_events;
  CREATE POLICY clinical_read ON acct_events AS RESTRICTIVE FOR SELECT USING (public.app_clinical_access());

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON acct_events, acct_digests, acct_verifications FROM %I', app);
    -- Digests are made by the worker only.
    EXECUTE format('REVOKE INSERT ON acct_digests FROM %I', app);
  END IF;
END
$outer$;
