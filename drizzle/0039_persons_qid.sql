-- 0039_persons_qid.sql: patient identity. Platform persons and QIDs, hospital MRNs, merges.
-- Design and rationale: docs/architecture/data-model.md and decisions.md (patient identity).

DO $chk$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION '0039 requires a UTF8 database (normalize() and the name key depend on it)';
  END IF;
END $chk$;

-- Owner of every identity SECURITY DEFINER function: trusted, never the app role,
-- never a superuser, cannot bypass RLS, cannot log in.
DO $role$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'qurio_identity_definer') THEN
    CREATE ROLE qurio_identity_definer NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $role$;
GRANT qurio_identity_definer TO CURRENT_USER;

-- Nothing but the migration owner may create objects in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

-- Deterministic, locale-independent name normalization (docs/architecture/data-model.md, Patient identity).
-- lib/domain/patient-match.ts#nameKey mirrors it exactly; the equivalence test pins them together.
CREATE OR REPLACE FUNCTION public.qurio_name_key(p text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $fn$
  SELECT btrim(
           regexp_replace(
             translate(
               translate(
                 translate(normalize(p, NFC),
                           E'\u0027\u2018\u2019\u200B\u2060\uFEFF',
                           ''),
                 E'!"#$%&()*+,-./:;<=>?@[\\]^_\u0060{|}~\u201C\u201D\u2013\u2014\u2026\u00B7\u0964\u0965',
                 repeat(' ', 39)),
               'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
               'abcdefghijklmnopqrstuvwxyz'),
             E'[ \t\n\r\u00A0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u3000]+',
             ' ',
             'g'),
           ' ')
$fn$;

-- QID check symbol: Luhn mod 32 over the Crockford alphabet; mirrored by lib/domain/uhid.ts.
CREATE FUNCTION public.qurio_qid_check_symbol(p_payload text)
RETURNS text
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ',
                ((32 - (sum(CASE WHEN (char_length(p_payload) - d.i) % 2 = 0
                                 THEN (2 * d.v) / 32 + (2 * d.v) % 32
                                 ELSE d.v END) % 32)::int) % 32) + 1,
                1)
  FROM (SELECT g.i, strpos('0123456789ABCDEFGHJKMNPQRSTVWXYZ', substr(p_payload, g.i, 1)) - 1 AS v
          FROM generate_series(1, char_length(p_payload)) AS g(i)) d
$fn$;

-- Canonical QID: exact format, no adjacent 0/Z (the one Luhn mod-32 transposition blind spot), valid check symbol.
CREATE FUNCTION public.qurio_is_valid_qid(p text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT p ~ '^QID-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$'
     AND replace(substr(p, 5), '-', '') !~ '(0Z|Z0)'
     AND right(p, 1) = public.qurio_qid_check_symbol(left(replace(substr(p, 5), '-', ''), 7))
$fn$;

CREATE TABLE persons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qid text NOT NULL UNIQUE CONSTRAINT persons_qid_valid CHECK (public.qurio_is_valid_qid(qid)),
  identity_name text,
  identity_name_key text,
  identity_gender text,
  identity_birth_year smallint CHECK (identity_birth_year BETWEEN 1900 AND 2100),
  created_by_hospital_id uuid REFERENCES hospitals(id) ON DELETE SET NULL,
  abha_number text CHECK (abha_number ~ '^[0-9]{14}$'),
  abha_address text,
  abha_linked_at timestamptz,
  abha_verified_at timestamptz,
  merged_into_person_id uuid REFERENCES persons(id),
  merged_at timestamptz,
  merged_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  erased_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT persons_merge_shape CHECK (
    (merged_into_person_id IS NULL) = (merged_at IS NULL)
    AND (merged_into_person_id IS NULL OR merged_into_person_id <> id)),
  CONSTRAINT persons_live_has_identity CHECK (
    erased_at IS NOT NULL OR (identity_name IS NOT NULL AND identity_name_key IS NOT NULL)),
  CONSTRAINT persons_minimized_holds_no_personal_data CHECK (
    erased_at IS NULL OR (
      identity_name IS NULL AND identity_name_key IS NULL AND identity_gender IS NULL
      AND identity_birth_year IS NULL AND abha_number IS NULL AND abha_address IS NULL
      AND abha_linked_at IS NULL AND abha_verified_at IS NULL AND created_by_hospital_id IS NULL))
);
CREATE UNIQUE INDEX persons_abha_key ON persons (abha_number)
  WHERE abha_number IS NOT NULL AND merged_into_person_id IS NULL;
CREATE INDEX persons_merged_into_idx ON persons (merged_into_person_id)
  WHERE merged_into_person_id IS NOT NULL;

CREATE TABLE person_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_person_id uuid NOT NULL REFERENCES persons(id),
  to_person_id uuid NOT NULL REFERENCES persons(id),
  from_qid text NOT NULL CHECK (public.qurio_is_valid_qid(from_qid)),
  to_qid text NOT NULL CHECK (public.qurio_is_valid_qid(to_qid)),
  flattened_person_ids uuid[] NOT NULL DEFAULT '{}',
  initiated_by text NOT NULL CHECK (initiated_by IN ('platform','hospital_local')),
  initiated_by_hospital_id uuid REFERENCES hospitals(id) ON DELETE SET NULL,
  reason text NOT NULL,
  merged_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_at timestamptz,
  undone_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (from_person_id <> to_person_id)
);

ALTER TABLE patients
  ADD COLUMN person_id uuid REFERENCES persons(id),
  ADD COLUMN qid text CONSTRAINT patients_qid_valid CHECK (qid IS NULL OR public.qurio_is_valid_qid(qid)),
  ADD COLUMN mrn text,
  ADD COLUMN name_key text,
  ADD COLUMN birth_year smallint,
  ADD COLUMN person_link_method text CHECK (person_link_method IN
    ('registered_here','qid_verified_at_desk','qid_otp_verified','abha_verified','person_merge')),
  ADD COLUMN person_link_qid text,
  ADD COLUMN person_linked_at timestamptz,
  ADD COLUMN person_linked_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN merged_into_id uuid,
  ADD COLUMN merged_at timestamptz,
  ADD COLUMN merged_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX patients_tenant_id_key ON patients (hospital_id, id);
ALTER TABLE patients ADD CONSTRAINT patients_merged_into_fk
  FOREIGN KEY (hospital_id, merged_into_id) REFERENCES patients (hospital_id, id);

CREATE TABLE person_merge_items (
  merge_id uuid NOT NULL REFERENCES person_merges(id),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  hospital_id uuid NOT NULL,
  old_person_id uuid NOT NULL,
  old_qid text NOT NULL CHECK (public.qurio_is_valid_qid(old_qid)),
  PRIMARY KEY (merge_id, patient_id)
);

CREATE TABLE patient_merges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  from_patient_id uuid NOT NULL,
  to_patient_id uuid NOT NULL,
  repointed_patient_ids uuid[] NOT NULL DEFAULT '{}',
  person_merge_id uuid REFERENCES person_merges(id),
  reason text NOT NULL,
  merged_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  undone_at timestamptz,
  undone_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (from_patient_id <> to_patient_id),
  FOREIGN KEY (hospital_id, from_patient_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE,
  FOREIGN KEY (hospital_id, to_patient_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE
);

CREATE TABLE person_identity_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id uuid NOT NULL REFERENCES persons(id),
  field text NOT NULL CHECK (field IN ('name','gender','birth_year')),
  old_value text,
  new_value text,
  reason text NOT NULL,
  corrected_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  corrected_by_hospital_id uuid REFERENCES hospitals(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE person_merge_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_merge_id uuid REFERENCES patient_merges(id) ON DELETE SET NULL,
  from_person_id uuid NOT NULL REFERENCES persons(id),
  to_person_id uuid NOT NULL REFERENCES persons(id),
  reason text NOT NULL,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','merged','rejected','withdrawn')),
  resolved_person_merge_id uuid REFERENCES person_merges(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  CHECK (from_person_id <> to_person_id)
);
CREATE UNIQUE INDEX person_merge_requests_one_pending
  ON person_merge_requests (patient_merge_id) WHERE status = 'pending';

CREATE TABLE person_verification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  qid text NOT NULL CHECK (char_length(qid) <= 13),
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  staff_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  outcome text NOT NULL CHECK (outcome IN ('match','no_match','rate_limited')),
  matched_person_id uuid REFERENCES persons(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((outcome = 'match') = (matched_person_id IS NOT NULL))
);
CREATE INDEX person_verification_attempts_qid_idx ON person_verification_attempts (qid, created_at);
CREATE INDEX person_verification_attempts_link_idx
  ON person_verification_attempts (hospital_id, matched_person_id, created_at) WHERE outcome = 'match';
CREATE INDEX person_verification_attempts_user_idx ON person_verification_attempts (staff_user_id, created_at);

CREATE TABLE patient_qid_aliases (
  hospital_id uuid NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  patient_id uuid NOT NULL,
  qid text NOT NULL CHECK (public.qurio_is_valid_qid(qid)),
  person_merge_id uuid NOT NULL REFERENCES person_merges(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, qid),
  FOREIGN KEY (hospital_id, patient_id) REFERENCES patients (hospital_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX patient_qid_aliases_hospital_qid_key ON patient_qid_aliases (hospital_id, qid);

ALTER TABLE hospitals
  ADD COLUMN mrn_prefix text CHECK (mrn_prefix ~ '^[A-Z0-9-]{0,8}$'),
  ADD COLUMN mrn_start integer NOT NULL DEFAULT 10001 CHECK (mrn_start > 0);

-- The MRN counter lives in document_sequences (kind 'mrn') and never restarts, so it has no
-- financial year: '-' is allowed for that kind only. Bill numbering keeps its "2026-27" form.
ALTER TABLE document_sequences DROP CONSTRAINT document_sequences_fiscal_year_check;
ALTER TABLE document_sequences ADD CONSTRAINT document_sequences_fiscal_year_check
  CHECK (fiscal_year ~ '^\d{4}-\d{2}$' OR (kind = 'mrn' AND fiscal_year = '-'));

ALTER TABLE bills
  ADD COLUMN patient_qid text CONSTRAINT bills_patient_qid_valid
    CHECK (patient_qid IS NULL OR public.qurio_is_valid_qid(patient_qid)),
  ADD COLUMN patient_mrn text;

CREATE INDEX patients_name_key_idx ON patients (hospital_id, name_key text_pattern_ops);
CREATE INDEX patients_qid_idx ON patients (hospital_id, qid);
CREATE INDEX patients_mrn_idx ON patients (hospital_id, mrn);
CREATE INDEX patients_person_idx ON patients (person_id);
CREATE INDEX patients_merged_into_idx ON patients (merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE INDEX patients_link_qid_idx ON patients (person_link_qid, person_linked_at) WHERE person_link_qid IS NOT NULL;

-- ===================================================================== triggers

-- persons: QID never changes; rows are permanent; key always derived; merge and
-- minimization only move forward, and merges only inside a recorded person merge.
CREATE FUNCTION public.persons_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_merge uuid := nullif(current_setting('app.person_merge_id', true), '')::uuid;
  m public.person_merges%ROWTYPE;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'persons rows are permanent; a QID is never freed for reuse';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.merged_into_person_id IS NOT NULL OR NEW.erased_at IS NOT NULL THEN
      RAISE EXCEPTION 'a person is created live and unmerged';
    END IF;
  ELSE
    IF NEW.qid IS DISTINCT FROM OLD.qid THEN
      RAISE EXCEPTION 'persons.qid never changes';
    END IF;
    IF OLD.erased_at IS NOT NULL AND NEW.erased_at IS DISTINCT FROM OLD.erased_at THEN
      RAISE EXCEPTION 'a minimized person stays minimized';
    END IF;
    IF NEW.merged_into_person_id IS DISTINCT FROM OLD.merged_into_person_id THEN
      SELECT * INTO m FROM public.person_merges pm WHERE pm.id = v_merge;
      IF NOT FOUND OR NOT (
           (m.undone_at IS NULL
              AND (NEW.id = m.from_person_id OR NEW.id = ANY (m.flattened_person_ids))
              AND NEW.merged_into_person_id = m.to_person_id)
        OR (m.undone_at IS NOT NULL AND NEW.id = m.from_person_id AND NEW.merged_into_person_id IS NULL)
        OR (m.undone_at IS NOT NULL AND NEW.id = ANY (m.flattened_person_ids)
              AND NEW.merged_into_person_id = m.from_person_id)
      ) THEN
        RAISE EXCEPTION 'persons.merged_into_person_id changes only as recorded by a person merge';
      END IF;
      IF NEW.merged_into_person_id IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM public.persons t
                    WHERE t.id = NEW.merged_into_person_id
                      AND (t.merged_into_person_id IS NOT NULL OR t.erased_at IS NOT NULL)) THEN
          RAISE EXCEPTION 'a person can be merged only into a live, unmerged person';
        END IF;
        IF EXISTS (SELECT 1 FROM public.persons s WHERE s.merged_into_person_id = NEW.id) THEN
          RAISE EXCEPTION 'flatten the persons merged into % before merging it', NEW.id;
        END IF;
      END IF;
    END IF;
  END IF;
  NEW.identity_name_key := public.qurio_name_key(NEW.identity_name);
  NEW.updated_at := now();
  RETURN NEW;
END $fn$;
CREATE TRIGGER persons_guard BEFORE INSERT OR UPDATE OR DELETE ON persons
  FOR EACH ROW EXECUTE FUNCTION public.persons_guard();

CREATE FUNCTION public.persons_no_truncate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$ BEGIN RAISE EXCEPTION 'persons cannot be truncated'; END $fn$;
CREATE TRIGGER persons_no_truncate BEFORE TRUNCATE ON persons
  FOR EACH STATEMENT EXECUTE FUNCTION public.persons_no_truncate();

-- patients: key always derived; MRN fixed; identity changes only in recorded merges.
CREATE FUNCTION public.patients_identity_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_person_merge  uuid := nullif(current_setting('app.person_merge_id', true), '')::uuid;
  v_patient_merge uuid := nullif(current_setting('app.patient_merge_id', true), '')::uuid;
  m public.person_merges%ROWTYPE;
BEGIN
  NEW.name_key := public.qurio_name_key(NEW.name);

  IF TG_OP = 'INSERT' THEN
    IF NEW.merged_into_id IS NOT NULL THEN
      RAISE EXCEPTION 'a patient row cannot be created already merged';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.mrn IS NOT NULL AND NEW.mrn IS DISTINCT FROM OLD.mrn THEN
    RAISE EXCEPTION 'patients.mrn never changes';
  END IF;

  IF (OLD.person_id IS NOT NULL AND NEW.person_id IS DISTINCT FROM OLD.person_id)
     OR (OLD.qid IS NOT NULL AND NEW.qid IS DISTINCT FROM OLD.qid) THEN
    IF OLD.merged_into_id IS NOT NULL OR NEW.merged_into_id IS NOT NULL THEN
      RAISE EXCEPTION 'a hospital-merged patient row keeps the identity it was merged with';
    END IF;
    SELECT * INTO m FROM public.person_merges pm WHERE pm.id = v_person_merge;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'patient identity changes only inside a recorded person merge';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.person_merge_items i WHERE i.merge_id = m.id AND i.patient_id = NEW.id) THEN
      RAISE EXCEPTION 'patient % is not an item of person merge %', NEW.id, m.id;
    END IF;
    IF NOT (
         (m.undone_at IS NULL     AND OLD.person_id = m.from_person_id AND NEW.person_id = m.to_person_id   AND NEW.qid = m.to_qid)
      OR (m.undone_at IS NOT NULL AND OLD.person_id = m.to_person_id   AND NEW.person_id = m.from_person_id AND NEW.qid = m.from_qid)
    ) THEN
      RAISE EXCEPTION 'patient re-parent does not match person merge %', m.id;
    END IF;
  END IF;

  IF NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN
    IF NOT EXISTS (SELECT 1 FROM public.patient_merges pm
                    WHERE pm.id = v_patient_merge AND pm.hospital_id = NEW.hospital_id) THEN
      RAISE EXCEPTION 'patients.merged_into_id changes only inside a recorded patient merge';
    END IF;
    IF NEW.merged_into_id IS NOT NULL AND EXISTS (
         SELECT 1 FROM public.patients s WHERE s.id = NEW.merged_into_id AND s.merged_into_id IS NOT NULL) THEN
      RAISE EXCEPTION 'a patient can be merged only into an active patient row';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER patients_identity_guard BEFORE INSERT OR UPDATE ON patients
  FOR EACH ROW EXECUTE FUNCTION public.patients_identity_guard();

-- New activity never lands on a hospital-merged row.
CREATE FUNCTION public.refuse_merged_patient()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_merged uuid;
BEGIN
  SELECT p.merged_into_id INTO v_merged FROM public.patients p WHERE p.id = NEW.patient_id FOR KEY SHARE;
  IF v_merged IS NOT NULL THEN
    RAISE EXCEPTION 'patient % is merged into %; record activity on the surviving row', NEW.patient_id, v_merged;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER appointments_active_patient BEFORE INSERT ON appointments
  FOR EACH ROW EXECUTE FUNCTION public.refuse_merged_patient();
CREATE TRIGGER encounters_active_patient BEFORE INSERT ON encounters
  FOR EACH ROW EXECUTE FUNCTION public.refuse_merged_patient();

-- ============================================================ identity context

-- The single tenant/staff check every identity definer function performs first.
-- p_staff_roles NULL: any non-read-only tenant transaction (public booking may register).
CREATE FUNCTION public.qurio_identity_context(p_staff_roles text[])
RETURNS TABLE (hospital_id uuid, staff_user_id uuid)
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hospital uuid;
  v_user uuid;
BEGIN
  BEGIN
    v_hospital := nullif(current_setting('app.hospital_id', true), '')::uuid;
    v_user := nullif(current_setting('app.staff_user_id', true), '')::uuid;
  EXCEPTION WHEN invalid_text_representation THEN
    RAISE EXCEPTION 'malformed tenant context';
  END;
  IF v_hospital IS NULL THEN
    RAISE EXCEPTION 'identity functions require a hospital session';
  END IF;
  IF coalesce(nullif(current_setting('app.read_only', true), '')::boolean, false) THEN
    RAISE EXCEPTION 'identity functions are refused in read-only sessions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.hospitals h WHERE h.id = v_hospital AND h.active) THEN
    RAISE EXCEPTION 'unknown or inactive hospital';
  END IF;
  IF p_staff_roles IS NOT NULL THEN
    IF v_user IS NULL THEN
      RAISE EXCEPTION 'this identity function requires an authenticated staff user';
    END IF;
    IF NOT EXISTS (
      SELECT 1
        FROM public.staff_memberships sm
        JOIN public.users u ON u.id = sm.user_id
       WHERE sm.user_id = v_user
         AND sm.hospital_id = v_hospital
         AND sm.active
         AND u.active
         AND sm.role::text = ANY (p_staff_roles)) THEN
      RAISE EXCEPTION 'staff user is not an active member of this hospital in a permitted role';
    END IF;
  END IF;
  RETURN QUERY SELECT v_hospital, v_user;
END $fn$;

-- ============================================================ definer functions

CREATE FUNCTION public.register_person(p_qid text, p_name text, p_gender text, p_birth_year smallint)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hospital uuid;
  v_id uuid;
BEGIN
  SELECT x.hospital_id INTO v_hospital FROM public.qurio_identity_context(NULL) x;
  IF NOT coalesce(public.qurio_is_valid_qid(p_qid), false) THEN
    RAISE EXCEPTION 'invalid QID: format or check symbol';
  END IF;
  IF coalesce(public.qurio_name_key(p_name), '') = '' THEN
    RAISE EXCEPTION 'a name with at least one letter or digit is required';
  END IF;
  INSERT INTO public.persons (qid, identity_name, identity_gender, identity_birth_year, created_by_hospital_id)
  VALUES (p_qid, btrim(p_name), p_gender, p_birth_year, v_hospital)
  RETURNING id INTO v_id;
  RETURN v_id;
END $fn$;

CREATE FUNCTION public.verify_person_by_qid(p_qid text, p_name text, p_birth_year smallint)
RETURNS TABLE (result text, matched_person_id uuid, canonical_qid text)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hospital uuid;
  v_user uuid;
  v_qid text := left(coalesce(p_qid, ''), 13);
  v_key text := public.qurio_name_key(p_name);
  v_outcome text := 'no_match';
  v_person uuid;
  v_canonical text;
  p public.persons%ROWTYPE;
  c public.persons%ROWTYPE;
BEGIN
  SELECT x.hospital_id, x.staff_user_id INTO v_hospital, v_user
    FROM public.qurio_identity_context(ARRAY['owner','receptionist','doctor']) x;

  IF (SELECT count(*) FROM public.person_verification_attempts a
       WHERE a.qid = v_qid AND a.outcome <> 'match' AND a.created_at > now() - interval '24 hours') >= 5
  OR (SELECT count(*) FROM public.person_verification_attempts a
       WHERE a.staff_user_id = v_user AND a.created_at > now() - interval '1 hour') >= 30 THEN
    v_outcome := 'rate_limited';
  ELSIF coalesce(public.qurio_is_valid_qid(p_qid), false)
        AND p_birth_year IS NOT NULL
        AND coalesce(v_key, '') <> '' THEN
    SELECT * INTO p FROM public.persons pp WHERE pp.qid = p_qid;
    IF FOUND THEN
      IF p.merged_into_person_id IS NULL THEN
        c := p;
      ELSE
        SELECT * INTO c FROM public.persons pp WHERE pp.id = p.merged_into_person_id;
      END IF;
      IF c.erased_at IS NULL AND (
           (c.identity_name_key = v_key AND abs(c.identity_birth_year - p_birth_year) <= 1)
        OR (p.id <> c.id AND p.erased_at IS NULL AND p.identity_name_key = v_key
            AND abs(p.identity_birth_year - p_birth_year) <= 1)) THEN
        v_outcome := 'match';
        v_person := c.id;
        v_canonical := c.qid;
      END IF;
    END IF;
  END IF;

  INSERT INTO public.person_verification_attempts (qid, hospital_id, staff_user_id, outcome, matched_person_id)
  VALUES (v_qid, v_hospital, v_user, v_outcome, v_person);
  RETURN QUERY SELECT v_outcome, v_person, v_canonical;
END $fn$;

CREATE FUNCTION public.correct_person_identity(
  p_person_id uuid, p_name text, p_gender text, p_birth_year smallint, p_reason text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hospital uuid;
  v_user uuid;
  p public.persons%ROWTYPE;
BEGIN
  SELECT x.hospital_id, x.staff_user_id INTO v_hospital, v_user
    FROM public.qurio_identity_context(ARRAY['owner']) x;
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required';
  END IF;
  IF coalesce(public.qurio_name_key(p_name), '') = '' THEN
    RAISE EXCEPTION 'a name with at least one letter or digit is required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.patients pt
                  WHERE pt.person_id = p_person_id
                    AND pt.hospital_id = v_hospital
                    AND pt.merged_into_id IS NULL) THEN
    RAISE EXCEPTION 'this hospital has no active record for that person';
  END IF;
  SELECT * INTO p FROM public.persons pp WHERE pp.id = p_person_id FOR UPDATE;
  IF p.erased_at IS NOT NULL OR p.merged_into_person_id IS NOT NULL THEN
    RAISE EXCEPTION 'only a live, canonical person can be corrected';
  END IF;
  INSERT INTO public.person_identity_corrections
    (person_id, field, old_value, new_value, reason, corrected_by_user_id, corrected_by_hospital_id)
  SELECT p_person_id, f.field, f.old_value, f.new_value, btrim(p_reason), v_user, v_hospital
    FROM (VALUES ('name', p.identity_name, btrim(p_name)),
                 ('gender', p.identity_gender, p_gender),
                 ('birth_year', p.identity_birth_year::text, p_birth_year::text)) AS f(field, old_value, new_value)
   WHERE f.old_value IS DISTINCT FROM f.new_value;
  UPDATE public.persons pp
     SET identity_name = btrim(p_name), identity_gender = p_gender, identity_birth_year = p_birth_year
   WHERE pp.id = p_person_id;
END $fn$;

CREATE FUNCTION public.merge_person_local(p_patient_merge_id uuid)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hospital uuid;
  v_user uuid;
  pm public.patient_merges%ROWTYPE;
  f public.persons%ROWTYPE;
  t public.persons%ROWTYPE;
  v_flat uuid[];
  v_merge uuid;
BEGIN
  SELECT x.hospital_id, x.staff_user_id INTO v_hospital, v_user
    FROM public.qurio_identity_context(ARRAY['owner']) x;

  SELECT * INTO pm FROM public.patient_merges m
   WHERE m.id = p_patient_merge_id AND m.hospital_id = v_hospital
   FOR UPDATE;
  IF NOT FOUND OR pm.undone_at IS NOT NULL OR pm.person_merge_id IS NOT NULL THEN
    RAISE EXCEPTION 'no open hospital merge with that id in this hospital';
  END IF;

  SELECT pp.* INTO f FROM public.persons pp JOIN public.patients pt ON pt.person_id = pp.id
   WHERE pt.id = pm.from_patient_id FOR UPDATE OF pp;
  SELECT pp.* INTO t FROM public.persons pp JOIN public.patients pt ON pt.person_id = pp.id
   WHERE pt.id = pm.to_patient_id FOR UPDATE OF pp;
  IF f.id IS NULL OR t.id IS NULL OR f.id = t.id THEN
    RAISE EXCEPTION 'the merged records do not belong to two different persons';
  END IF;
  IF f.merged_into_person_id IS NOT NULL OR t.merged_into_person_id IS NOT NULL
     OR f.erased_at IS NOT NULL OR t.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'both persons must be live and unmerged';
  END IF;
  IF EXISTS (SELECT 1 FROM public.patients pt
              WHERE pt.hospital_id <> v_hospital
                AND (pt.person_id = f.id
                     OR pt.person_id IN (SELECT s.id FROM public.persons s WHERE s.merged_into_person_id = f.id))) THEN
    RAISE EXCEPTION 'that person has records at another hospital; request a platform merge instead';
  END IF;

  SELECT coalesce(array_agg(s.id), '{}') INTO v_flat
    FROM public.persons s WHERE s.merged_into_person_id = f.id;

  INSERT INTO public.person_merges
    (from_person_id, to_person_id, from_qid, to_qid, flattened_person_ids,
     initiated_by, initiated_by_hospital_id, reason, merged_by_user_id)
  VALUES (f.id, t.id, f.qid, t.qid, v_flat, 'hospital_local', v_hospital, pm.reason, v_user)
  RETURNING id INTO v_merge;

  PERFORM set_config('app.person_merge_id', v_merge::text, true);
  UPDATE public.persons pp SET merged_into_person_id = t.id WHERE pp.id = ANY (v_flat);
  UPDATE public.persons pp
     SET merged_into_person_id = t.id, merged_at = now(), merged_by_user_id = v_user
   WHERE pp.id = f.id;
  PERFORM set_config('app.person_merge_id', '', true);

  UPDATE public.patient_merges m SET person_merge_id = v_merge WHERE m.id = pm.id;
  RETURN v_merge;
END $fn$;

CREATE FUNCTION public.request_person_merge(p_patient_merge_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_hospital uuid;
  v_user uuid;
  pm public.patient_merges%ROWTYPE;
  v_from uuid;
  v_to uuid;
BEGIN
  SELECT x.hospital_id, x.staff_user_id INTO v_hospital, v_user
    FROM public.qurio_identity_context(ARRAY['owner']) x;
  IF coalesce(btrim(p_reason), '') = '' THEN
    RAISE EXCEPTION 'a reason is required';
  END IF;
  SELECT * INTO pm FROM public.patient_merges m
   WHERE m.id = p_patient_merge_id AND m.hospital_id = v_hospital;
  IF NOT FOUND OR pm.undone_at IS NOT NULL OR pm.person_merge_id IS NOT NULL THEN
    RAISE EXCEPTION 'no open hospital merge with that id in this hospital';
  END IF;
  SELECT pt.person_id INTO v_from FROM public.patients pt WHERE pt.id = pm.from_patient_id;
  SELECT pt.person_id INTO v_to FROM public.patients pt WHERE pt.id = pm.to_patient_id;
  IF v_from IS NULL OR v_to IS NULL OR v_from = v_to THEN
    RAISE EXCEPTION 'the merged records do not belong to two different persons';
  END IF;
  INSERT INTO public.person_merge_requests
    (hospital_id, patient_merge_id, from_person_id, to_person_id, reason, requested_by_user_id)
  VALUES (v_hospital, pm.id, v_from, v_to, btrim(p_reason), v_user)
  ON CONFLICT DO NOTHING;
END $fn$;

-- Admin connection only: data-minimize one person (merge and minimization are independent). Not a definer; the app cannot run it.
CREATE FUNCTION public.minimize_person(p_person_id uuid)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  v_qid text;
BEGIN
  UPDATE public.persons pp
     SET identity_name = NULL, identity_gender = NULL, identity_birth_year = NULL,
         abha_number = NULL, abha_address = NULL, abha_linked_at = NULL, abha_verified_at = NULL,
         created_by_hospital_id = NULL, erased_at = coalesce(pp.erased_at, now())
   WHERE pp.id = p_person_id
  RETURNING pp.qid INTO v_qid;
  IF v_qid IS NULL THEN
    RAISE EXCEPTION 'no such person';
  END IF;
  UPDATE public.person_identity_corrections c
     SET old_value = NULL, new_value = NULL, reason = 'minimized'
   WHERE c.person_id = p_person_id;
  UPDATE public.person_merges m SET reason = 'minimized'
   WHERE p_person_id IN (m.from_person_id, m.to_person_id);
  UPDATE public.person_merge_requests r SET reason = 'minimized'
   WHERE p_person_id IN (r.from_person_id, r.to_person_id);
  DELETE FROM public.person_verification_attempts a WHERE a.qid = v_qid;
END $fn$;

-- Linking a patient row to a person. The app role may set person_id/qid only to a live,
-- canonical person by that person's own QID, and only if the person was registered by this
-- hospital or a staff member here verified the presented QID within the last 30 minutes.
-- Without this an app-role caller could attach a row to any person id it learned.
-- The admin connection (backfill, platform merges) is exempt.
CREATE FUNCTION public.patients_link_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
DECLARE
  p public.persons%ROWTYPE;
BEGIN
  IF NEW.person_id IS NULL AND NEW.qid IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.person_id IS NOT DISTINCT FROM OLD.person_id AND NEW.qid IS NOT DISTINCT FROM OLD.qid THEN
      RETURN NEW;
    END IF;
    IF OLD.person_id IS NOT NULL THEN
      RETURN NEW;  -- re-parenting: patients_identity_guard allows it only inside a recorded person merge
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname = session_user AND (r.rolsuper OR r.rolbypassrls)) THEN
    RETURN NEW;
  END IF;
  SELECT * INTO p FROM public.persons pp WHERE pp.id = NEW.person_id;
  IF NOT FOUND OR p.qid IS DISTINCT FROM NEW.qid
     OR p.merged_into_person_id IS NOT NULL OR p.erased_at IS NOT NULL THEN
    RAISE EXCEPTION 'a patient row must link to a live, canonical person by that person''s own QID';
  END IF;
  IF NEW.person_link_method = 'registered_here' AND p.created_by_hospital_id = NEW.hospital_id THEN
    RETURN NEW;
  END IF;
  IF NEW.person_link_method = 'qid_verified_at_desk' AND EXISTS (
       SELECT 1 FROM public.person_verification_attempts a
        WHERE a.hospital_id = NEW.hospital_id
          AND a.matched_person_id = NEW.person_id
          AND a.outcome = 'match'
          AND a.qid = NEW.person_link_qid
          AND a.created_at > now() - interval '30 minutes') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'linking a patient to a person needs a registration by this hospital or a recent verified QID';
END $fn$;
CREATE TRIGGER patients_link_guard BEFORE INSERT OR UPDATE OF person_id, qid ON patients
  FOR EACH ROW EXECUTE FUNCTION public.patients_link_guard();

-- ============================================================ ownership and execute

ALTER FUNCTION public.qurio_identity_context(text[]) OWNER TO qurio_identity_definer;
ALTER FUNCTION public.patients_link_guard() OWNER TO qurio_identity_definer;
ALTER FUNCTION public.register_person(text, text, text, smallint) OWNER TO qurio_identity_definer;
ALTER FUNCTION public.verify_person_by_qid(text, text, smallint) OWNER TO qurio_identity_definer;
ALTER FUNCTION public.correct_person_identity(uuid, text, text, smallint, text) OWNER TO qurio_identity_definer;
ALTER FUNCTION public.merge_person_local(uuid) OWNER TO qurio_identity_definer;
ALTER FUNCTION public.request_person_merge(uuid, text) OWNER TO qurio_identity_definer;

REVOKE ALL ON FUNCTION public.qurio_identity_context(text[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.patients_link_guard() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.register_person(text, text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_person_by_qid(text, text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.correct_person_identity(uuid, text, text, smallint, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.merge_person_local(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_person_merge(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.minimize_person(uuid) FROM PUBLIC;


-- ============================================================ table access

-- Platform identity tables: forced RLS; the only policies are for the definer role;
-- the app role holds no privileges at all.
ALTER TABLE persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE persons FORCE ROW LEVEL SECURITY;
ALTER TABLE person_identity_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_identity_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE person_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_merges FORCE ROW LEVEL SECURITY;
ALTER TABLE person_merge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_merge_items FORCE ROW LEVEL SECURITY;
ALTER TABLE person_merge_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_merge_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE person_verification_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE person_verification_attempts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE persons, person_identity_corrections, person_merges, person_merge_items,
  person_merge_requests, person_verification_attempts FROM PUBLIC;

CREATE POLICY persons_definer ON persons TO qurio_identity_definer USING (true) WITH CHECK (true);
CREATE POLICY person_identity_corrections_definer ON person_identity_corrections
  TO qurio_identity_definer USING (true) WITH CHECK (true);
CREATE POLICY person_merges_definer ON person_merges TO qurio_identity_definer USING (true) WITH CHECK (true);
CREATE POLICY person_merge_requests_definer ON person_merge_requests
  TO qurio_identity_definer USING (true) WITH CHECK (true);
CREATE POLICY person_verification_attempts_definer ON person_verification_attempts
  TO qurio_identity_definer USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE ON persons, person_merges, person_merge_requests TO qurio_identity_definer;
GRANT SELECT, INSERT ON person_identity_corrections, person_verification_attempts TO qurio_identity_definer;

-- What the definer may read elsewhere. Tenant RLS still confines hospitals, staff_memberships
-- and patient_merges to app.hospital_id; the one cross-hospital read is the patients policy below.
GRANT SELECT (id, active) ON hospitals TO qurio_identity_definer;
GRANT SELECT (id, active) ON users TO qurio_identity_definer;
GRANT SELECT (user_id, hospital_id, role, active) ON staff_memberships TO qurio_identity_definer;
GRANT SELECT (id, hospital_id, person_id, merged_into_id) ON patients TO qurio_identity_definer;
CREATE POLICY patients_identity_definer_read ON patients
  FOR SELECT TO qurio_identity_definer USING (true);
GRANT SELECT, UPDATE (person_merge_id) ON patient_merges TO qurio_identity_definer;

-- Tenant tables: the standard tenant policy and the 0023 read-only restrictive policies.
ALTER TABLE patient_merges ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_merges FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_merges
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid)
  WITH CHECK (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
CREATE POLICY read_only_insert ON patient_merges AS RESTRICTIVE FOR INSERT
  WITH CHECK (NOT public.app_read_only());
CREATE POLICY read_only_update ON patient_merges AS RESTRICTIVE FOR UPDATE
  USING (NOT public.app_read_only()) WITH CHECK (NOT public.app_read_only());
CREATE POLICY read_only_delete ON patient_merges AS RESTRICTIVE FOR DELETE
  USING (NOT public.app_read_only());
ALTER TABLE patient_qid_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE patient_qid_aliases FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON patient_qid_aliases
  USING (hospital_id = nullif(current_setting('app.hospital_id', true), '')::uuid);
REVOKE ALL ON patient_qid_aliases FROM PUBLIC;

-- ============================================================ self-check

DO $audit$
DECLARE
  r record;
  n int := 0;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles
              WHERE rolname = 'qurio_identity_definer' AND (rolsuper OR rolbypassrls OR rolcanlogin)) THEN
    RAISE EXCEPTION 'qurio_identity_definer must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS';
  END IF;
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS fn, pg_get_userbyid(p.proowner) AS owner, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.proname IN ('register_person','verify_person_by_qid','correct_person_identity',
                         'merge_person_local','request_person_merge','patients_link_guard')
  LOOP
    n := n + 1;
    IF NOT r.prosecdef OR r.owner <> 'qurio_identity_definer' THEN
      RAISE EXCEPTION '% must be SECURITY DEFINER owned by qurio_identity_definer', r.fn;
    END IF;
    IF r.proconfig IS NULL OR NOT ('search_path=pg_catalog, pg_temp' = ANY (r.proconfig)) THEN
      RAISE EXCEPTION '% must pin search_path to pg_catalog, pg_temp', r.fn;
    END IF;
    IF has_function_privilege('public', r.oid, 'EXECUTE') THEN
      RAISE EXCEPTION '% must not be executable by PUBLIC', r.fn;
    END IF;
  END LOOP;
  IF n <> 6 THEN
    RAISE EXCEPTION 'expected 6 identity definer functions, found %', n;
  END IF;
END $audit$;

-- ============================================================ application role

-- The app role's name is configurable (APP_DB_ROLE, default opd_app; see scripts/db-bootstrap.ts).
-- scripts/migrate.ts passes it as qurio.app_role. Its default privileges from the bootstrap would
-- otherwise grant it the platform identity tables, so they are revoked explicitly here.
DO $app$
DECLARE
  app text := coalesce(nullif(current_setting('qurio.app_role', true), ''), 'opd_app');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app) THEN
    RAISE EXCEPTION 'application role % does not exist; run npm run db:bootstrap first', app;
  END IF;

  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', app);
  EXECUTE format('REVOKE ALL ON FUNCTION public.qurio_identity_context(text[]) FROM %I', app);
  EXECUTE format('REVOKE ALL ON FUNCTION public.minimize_person(uuid) FROM %I', app);
  EXECUTE format('REVOKE ALL ON FUNCTION public.patients_link_guard() FROM %I', app);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.register_person(text, text, text, smallint) TO %I', app);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.verify_person_by_qid(text, text, smallint) TO %I', app);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.correct_person_identity(uuid, text, text, smallint, text) TO %I', app);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.merge_person_local(uuid) TO %I', app);
  EXECUTE format('GRANT EXECUTE ON FUNCTION public.request_person_merge(uuid, text) TO %I', app);
  EXECUTE format('REVOKE ALL ON TABLE public.persons, public.person_identity_corrections, public.person_merges, '
                 'public.person_merge_items, public.person_merge_requests, public.person_verification_attempts FROM %I', app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.patient_merges TO %I', app);
  EXECUTE format('REVOKE ALL ON public.patient_qid_aliases FROM %I', app);
  EXECUTE format('GRANT SELECT ON public.patient_qid_aliases TO %I', app);

  IF has_function_privilege(app, 'public.minimize_person(uuid)', 'EXECUTE')
     OR has_function_privilege(app, 'public.qurio_identity_context(text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'the app role must not execute minimize_person or qurio_identity_context';
  END IF;
  IF has_schema_privilege(app, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'the app role must not be able to create objects in public';
  END IF;
  IF has_table_privilege(app, 'public.persons', 'SELECT') THEN
    RAISE EXCEPTION 'the app role must not read persons';
  END IF;
  IF NOT has_function_privilege(app, 'public.verify_person_by_qid(text, text, smallint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'the app role must be able to execute the identity functions';
  END IF;
END $app$;
