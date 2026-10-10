import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { patients } from '@/lib/db/schema';
import { birthYearFromAge, nameKey } from '@/lib/domain/patient-match';
import { generateQid, isValidQid, normalizeQid } from '@/lib/domain/uhid';

/**
 * Patient identity (docs: the rev. 6 identity plan; migration 0039).
 *
 * Every patient row belongs to a platform person, who carries the QID; the
 * row carries this hospital's MRN. Rows are either ACTIVE (merged_into_id
 * null) or HOSPITAL-MERGED into an ACTIVE row of the same hospital, and every
 * read of "this patient" goes through resolveRow to the ACTIVE one.
 *
 * The app role cannot read `persons`. It reaches identity only through the
 * definer functions (register_person, verify_person_by_qid, ...), and the
 * database refuses to link a row to a person unless the person was registered
 * here or a staff member just verified the presented QID (patients_link_guard).
 *
 * Lock order, everywhere a patient is created: the phone/person advisory lock,
 * then the MRN counter, then — in the caller — the doctor-day lock. Every
 * booking path resolves the patient before it touches the doctor's day.
 */

export type PatientRow = typeof patients.$inferSelect;

export type PatientDetails = {
  phoneE164: string;
  name: string;
  age?: number | null;
  gender?: string | null;
  /** Optional free text. A blank here never erases an address on file. */
  address?: string | null;
  locale?: 'mr' | 'hi' | 'en';
};

/**
 * What the caller knows about the patient.
 *
 * - `existing`: a patient id already in hand (a picker, a follow-up).
 * - `verified`: a QID verified at this desk in this request
 *   (verifyQidIdentityForLinking). The database re-checks it.
 * - `details`: typed details. Reuses this hospital's record with the same
 *   phone and the same name key (as the old phone + name upsert did, without
 *   being thrown by case or punctuation), unless `forceNew` says the desk
 *   confirmed this is a different person.
 */
export type PatientInput =
  | { kind: 'existing'; patientId: string }
  | { kind: 'verified'; personId: string; canonicalQid: string; presentedQid: string; details: PatientDetails }
  | { kind: 'details'; details: PatientDetails; forceNew?: boolean };

export class PatientIdentityError extends Error {}

const errorCode = (error: unknown): string | undefined => {
  const e = error as { code?: string; cause?: { code?: string } };
  return e?.code ?? e?.cause?.code;
};

const errorText = (error: unknown): string => {
  const e = error as { message?: string; cause?: { message?: string } };
  return e?.cause?.message ?? e?.message ?? String(error);
};

const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');

/** The ACTIVE row a patient id resolves to: itself, or the row it was merged into. */
export async function resolveRow(tx: Tx, patientId: string): Promise<string> {
  const [row] = await tx
    .select({ id: patients.id, mergedIntoId: patients.mergedIntoId })
    .from(patients)
    .where(eq(patients.id, patientId));
  if (!row) throw new PatientIdentityError('Patient not found');
  return row.mergedIntoId ?? row.id;
}

/**
 * The rows whose records make up one patient's history in this hospital: the
 * ACTIVE row and every row merged into it.
 */
export async function patientGroupIds(tx: Tx, patientId: string): Promise<string[]> {
  const survivor = await resolveRow(tx, patientId);
  const rows = await tx
    .select({ id: patients.id })
    .from(patients)
    .where(sql`${patients.id} = ${survivor}::uuid or ${patients.mergedIntoId} = ${survivor}::uuid`);
  return rows.map((r) => r.id);
}

/**
 * The next MRN for this hospital, on the same row-locked counter as bill
 * numbers. Serializes new registrations in one hospital until the transaction
 * ends; a rollback releases the number unissued. `greatest` honours a raised
 * mrn_start.
 */
export async function nextMrnInTx(tx: Tx, hospitalId: string): Promise<string> {
  const [row] = await tx.execute<{ mrn: string }>(sql`
    with h as (
      select mrn_prefix, mrn_start from hospitals where id = ${hospitalId}::uuid
    ),
    s as (
      insert into document_sequences (hospital_id, kind, fiscal_year, last_number)
      select ${hospitalId}::uuid, 'mrn', '-', h.mrn_start from h
      on conflict (hospital_id, kind, fiscal_year) do update
        set last_number = greatest(document_sequences.last_number + 1, excluded.last_number),
            updated_at = now()
      returning last_number
    )
    select coalesce(h.mrn_prefix, '') || s.last_number::text as mrn from s, h
  `);
  if (!row) throw new PatientIdentityError('Hospital not found');
  return row.mrn;
}

/**
 * Registers a new person and returns its id and QID. A QID collision (one in
 * billions) is retried under a savepoint, so it never aborts the caller's
 * transaction.
 */
async function registerPersonInTx(
  tx: Tx,
  person: { name: string; gender: string | null; birthYear: number | null },
): Promise<{ personId: string; qid: string }> {
  for (let attempt = 0; ; attempt++) {
    const qid = generateQid();
    try {
      const personId = await tx.transaction(async (sp) => {
        const [row] = await sp.execute<{ id: string }>(sql`
          select public.register_person(
            ${qid}, ${person.name}, ${person.gender}, ${person.birthYear}::smallint
          ) as id
        `);
        return row.id;
      });
      return { personId, qid };
    } catch (error) {
      if (errorCode(error) === '23505' && attempt < 3) continue;
      throw error;
    }
  }
}

/**
 * Gives a row without identity (created before 0039 and not yet backfilled)
 * its person, QID and MRN. Locks the row first, so two requests for the same
 * patient cannot both register a person.
 */
async function ensureIdentityInTx(
  tx: Tx,
  hospitalId: string,
  patientId: string,
  actorUserId: string | null,
  now: Date,
): Promise<void> {
  const [row] = await tx
    .select({
      personId: patients.personId,
      name: patients.name,
      gender: patients.gender,
      age: patients.age,
      birthYear: patients.birthYear,
      mrn: patients.mrn,
    })
    .from(patients)
    .where(eq(patients.id, patientId))
    .for('update');
  if (!row || row.personId) return;

  const birthYear = row.birthYear ?? birthYearFromAge(row.age, now);
  const { personId, qid } = await registerPersonInTx(tx, { name: row.name, gender: row.gender, birthYear });
  const mrn = row.mrn ?? (await nextMrnInTx(tx, hospitalId));
  await tx
    .update(patients)
    .set({
      personId,
      qid,
      mrn,
      birthYear,
      personLinkMethod: 'registered_here',
      personLinkedAt: now,
      personLinkedByUserId: actorUserId,
    })
    .where(eq(patients.id, patientId));
}

/** Contact and demographic refresh on a returning patient. A blank never erases. */
async function refreshDetailsInTx(
  tx: Tx,
  patientId: string,
  details: Partial<PatientDetails> | null,
  whatsappOptIn: boolean,
  now: Date,
) {
  await tx
    .update(patients)
    .set({
      age: sql`coalesce(${details?.age ?? null}::smallint, ${patients.age})`,
      gender: sql`coalesce(${details?.gender ?? null}, ${patients.gender})`,
      address: sql`coalesce(${details?.address?.trim() || null}, ${patients.address})`,
      whatsappOptInAt: whatsappOptIn
        ? sql`coalesce(${patients.whatsappOptInAt}, ${now.toISOString()}::timestamptz)`
        : patients.whatsappOptInAt,
      updatedAt: now,
    })
    .where(eq(patients.id, patientId));
}

async function insertPatientInTx(
  tx: Tx,
  hospitalId: string,
  details: PatientDetails,
  identity: {
    personId: string;
    qid: string;
    method: 'registered_here' | 'qid_verified_at_desk';
    presentedQid: string | null;
  },
  whatsappOptIn: boolean,
  actorUserId: string | null,
  now: Date,
): Promise<string> {
  const mrn = await nextMrnInTx(tx, hospitalId);
  try {
    const [row] = await tx
      .insert(patients)
      .values({
        hospitalId,
        phoneE164: details.phoneE164,
        name: cleanName(details.name),
        age: details.age ?? null,
        gender: details.gender ?? null,
        address: details.address?.trim() || null,
        locale: details.locale ?? 'en',
        whatsappOptInAt: whatsappOptIn ? now : null,
        personId: identity.personId,
        qid: identity.qid,
        mrn,
        birthYear: birthYearFromAge(details.age, now),
        personLinkMethod: identity.method,
        personLinkQid: identity.presentedQid,
        personLinkedAt: now,
        personLinkedByUserId: actorUserId,
      })
      .returning({ id: patients.id });
    return row.id;
  } catch (error) {
    // Until 0040 drops it, the old (hospital, phone, exact name) key still applies.
    if (errorCode(error) === '23505' && errorText(error).includes('patients_hospital_phone_name_key')) {
      throw new PatientIdentityError(
        'A patient with this exact name and phone is already registered. Pick that record, or change the name.',
      );
    }
    throw error;
  }
}

/**
 * The one way a patient row is found or created for a visit, an admission or
 * a booking. Returns the ACTIVE row, with identity (person, QID, MRN) in place.
 *
 * Call it before taking the doctor-day lock (see the lock order above).
 */
export async function resolvePatientInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    input: PatientInput;
    /** Record WhatsApp consent if not already on file. Never withdraws it. */
    whatsappOptIn?: boolean;
    actorUserId?: string | null;
    now?: Date;
  },
): Promise<PatientRow> {
  const now = args.now ?? new Date();
  const actor = args.actorUserId ?? null;
  const optIn = args.whatsappOptIn ?? false;
  const { input, hospitalId } = args;
  let patientId: string;

  if (input.kind === 'existing') {
    patientId = await resolveRow(tx, input.patientId);
    if (optIn) await refreshDetailsInTx(tx, patientId, null, true, now);
  } else if (input.kind === 'verified') {
    if (!isValidQid(input.canonicalQid)) throw new PatientIdentityError('Invalid QID');
    // One ACTIVE row per (hospital, person); 0040 adds the unique index.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${hospitalId}:person:${input.personId}`}, 0))`);
    const [active] = await tx
      .select({ id: patients.id })
      .from(patients)
      .where(and(eq(patients.personId, input.personId), isNull(patients.mergedIntoId)))
      .orderBy(asc(patients.createdAt))
      .limit(1);
    if (active) {
      patientId = active.id;
      await refreshDetailsInTx(tx, patientId, input.details, optIn, now);
    } else {
      patientId = await insertPatientInTx(
        tx,
        hospitalId,
        input.details,
        {
          personId: input.personId,
          qid: input.canonicalQid,
          method: 'qid_verified_at_desk',
          presentedQid: input.presentedQid,
        },
        optIn,
        actor,
        now,
      );
    }
  } else {
    const details = input.details;
    const name = cleanName(details.name);
    if (!nameKey(name)) throw new PatientIdentityError('Enter the patient’s name');
    // Serializes registrations on one phone, so two taps cannot create two records.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${hospitalId}:phone:${details.phoneE164}`}, 0))`);
    let found: string | undefined;
    if (!input.forceNew) {
      // name_key is null on rows not written since 0039, hence the coalesce.
      const [hit] = await tx
        .select({ id: sql<string>`coalesce(${patients.mergedIntoId}, ${patients.id})` })
        .from(patients)
        .where(
          and(
            eq(patients.hospitalId, hospitalId),
            eq(patients.phoneE164, details.phoneE164),
            sql`coalesce(${patients.nameKey}, public.qurio_name_key(${patients.name})) = public.qurio_name_key(${name})`,
          ),
        )
        .orderBy(desc(sql`${patients.mergedIntoId} is null`), asc(patients.createdAt))
        .limit(1);
      found = hit?.id;
    }
    if (found) {
      patientId = found;
      await refreshDetailsInTx(tx, patientId, details, optIn, now);
    } else {
      const birthYear = birthYearFromAge(details.age, now);
      const person = await registerPersonInTx(tx, { name, gender: details.gender ?? null, birthYear });
      patientId = await insertPatientInTx(
        tx,
        hospitalId,
        { ...details, name },
        { personId: person.personId, qid: person.qid, method: 'registered_here', presentedQid: null },
        optIn,
        actor,
        now,
      );
    }
  }

  await ensureIdentityInTx(tx, hospitalId, patientId, actor, now);
  const [row] = await tx.select().from(patients).where(eq(patients.id, patientId));
  return row;
}

/* ------------------------------------------------------------ verification */

export type QidVerification =
  | { result: 'match'; personId: string; canonicalQid: string; presentedQid: string }
  | { result: 'no_match' | 'rate_limited' | 'invalid_qid' };

/**
 * Checks a QID a patient presented against the name and birth year they give
 * at the desk. Answers only match / no_match / rate_limited, never identity
 * data. Needs an authenticated staff session (owner, receptionist or doctor)
 * of this hospital: the database refuses public, WhatsApp and worker paths.
 *
 * A match lets this hospital link (or create) its record for that person
 * within the next 30 minutes — resolvePatientInTx with kind 'verified'.
 */
export async function verifyQidIdentityForLinking(args: {
  hospitalId: string;
  qid: string;
  name: string;
  birthYear: number;
}): Promise<QidVerification> {
  const presentedQid = normalizeQid(args.qid);
  if (!presentedQid || !isValidQid(presentedQid)) return { result: 'invalid_qid' };
  const [row] = await withTenant(args.hospitalId, (tx) =>
    tx.execute<{ result: 'match' | 'no_match' | 'rate_limited'; matched_person_id: string | null; canonical_qid: string | null }>(
      sql`select * from public.verify_person_by_qid(${presentedQid}, ${args.name}, ${args.birthYear}::smallint)`,
    ),
  );
  if (row?.result === 'match' && row.matched_person_id && row.canonical_qid) {
    return { result: 'match', personId: row.matched_person_id, canonicalQid: row.canonical_qid, presentedQid };
  }
  return { result: row?.result === 'rate_limited' ? 'rate_limited' : 'no_match' };
}

/**
 * Corrects the platform identity data of the person behind one of this
 * hospital's patients. Owner only (checked again in the database), audited per
 * field in person_identity_corrections. The QID never changes; the patient's
 * local name, age and gender here are edited separately.
 */
export async function correctPersonIdentity(args: {
  hospitalId: string;
  patientId: string;
  name: string;
  gender: string | null;
  birthYear: number | null;
  reason: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const survivor = await resolveRow(tx, args.patientId);
    const [row] = await tx.select({ personId: patients.personId }).from(patients).where(eq(patients.id, survivor));
    if (!row?.personId) throw new PatientIdentityError('This patient has no QID yet');
    try {
      await tx.execute(sql`
        select public.correct_person_identity(
          ${row.personId}::uuid, ${args.name}, ${args.gender}, ${args.birthYear}::smallint, ${args.reason}
        )
      `);
    } catch (error) {
      throw new PatientIdentityError(errorText(error));
    }
  });
}

/* ------------------------------------------------------------------ search */

export type PatientSearchHit = {
  patientId: string;
  name: string;
  phoneE164: string;
  age: number | null;
  gender: string | null;
  qid: string | null;
  mrn: string | null;
  /** How the hit was found when not directly: an old merged record, or a former QID. */
  matchedVia: 'merged_record' | 'former_qid' | null;
};

/**
 * Finds this hospital's patients by QID (current or former), MRN, phone or
 * name. Always returns ACTIVE rows: a hit on a merged record or a former QID
 * returns the record it now lives in, labelled. Tenant RLS keeps it to this
 * hospital; there is no cross-hospital lookup.
 */
export async function searchHospitalPatients(args: {
  hospitalId: string;
  query: string;
  limit?: number;
}): Promise<PatientSearchHit[]> {
  const query = args.query.trim();
  if (!query) return [];
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 50);
  const qid = normalizeQid(query);
  const exactQid = qid && isValidQid(qid) ? qid : null;
  const digits = query.replace(/\D/g, '');
  const key = nameKey(query);
  const mrn = query.toUpperCase().replace(/\s+/g, '');

  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      name: string;
      phone_e164: string;
      age: number | null;
      gender: string | null;
      qid: string | null;
      mrn: string | null;
      via: 'merged_record' | 'former_qid' | null;
    }>(sql`
      with direct as (
        select p.id, p.merged_into_id
          from patients p
         where p.hospital_id = ${args.hospitalId}::uuid
           and (
             ${exactQid}::text is not null and p.qid = ${exactQid}
             or p.mrn = ${mrn}
             or (${digits.length >= 5} and p.phone_e164 like '%' || ${digits} || '%')
             or (${key.length >= 2} and (
                   coalesce(p.name_key, public.qurio_name_key(p.name)) like ${key} || '%'
                   or coalesce(p.name_key, public.qurio_name_key(p.name)) like '% ' || ${key} || '%'))
           )
      ),
      hits as (
        select coalesce(d.merged_into_id, d.id) as id,
               case when d.merged_into_id is not null then 'merged_record' end as via
          from direct d
        union all
        select a.patient_id, 'former_qid'
          from patient_qid_aliases a
         where ${exactQid}::text is not null and a.qid = ${exactQid}
      ),
      ranked as (
        select distinct on (h.id) h.id, h.via
          from hits h
         order by h.id, h.via nulls first
      )
      select p.id, p.name, p.phone_e164, p.age, p.gender, p.qid, p.mrn, r.via
        from ranked r
        join patients p on p.id = coalesce((select m.merged_into_id from patients m where m.id = r.id), r.id)
       order by r.via nulls first, p.updated_at desc
       limit ${limit}
    `);
    const seen = new Set<string>();
    const out: PatientSearchHit[] = [];
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({
        patientId: r.id,
        name: r.name,
        phoneE164: r.phone_e164,
        age: r.age === null ? null : Number(r.age),
        gender: r.gender,
        qid: r.qid,
        mrn: r.mrn,
        matchedVia: r.via,
      });
    }
    return out;
  });
}
