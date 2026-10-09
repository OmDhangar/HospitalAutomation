import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { withRequestContext } from '@/lib/db/request-context';
import { patients } from '@/lib/db/schema';
import { isValidQid } from '@/lib/domain/uhid';
import {
  PatientIdentityError,
  correctPersonIdentity,
  patientGroupIds,
  resolvePatientInTx,
  searchHospitalPatients,
  verifyQidIdentityForLinking,
} from '@/lib/services/patients';
import { createWalkIn } from '@/lib/services/queue';
import { sql } from 'drizzle-orm';

/**
 * Patient identity against a real database, over the real app role (0039):
 * every new patient gets a person, a QID and an MRN; a returning patient is
 * found by phone and name key; MRNs never collide under concurrency; a QID
 * from another hospital links only after verification at the desk, and the
 * database refuses every shortcut.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const TZ = 'Asia/Kolkata';
const HOSPITAL_NAME = 'Patient Identity Test Hospital';

describe.skipIf(!enabled)('patient identity', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);
  const hospitalA = uuid();
  const hospitalB = uuid();
  const branchA = uuid();
  const doctorA = uuid();
  const ownerA = uuid();
  const deskA = uuid();
  const nurseA = uuid();
  const ownerB = uuid();
  let phone = 100;
  const nextPhone = () => `+91960000${String((phone += 1)).padStart(4, '0')}`;

  const asStaff = <T>(userId: string, fn: () => Promise<T>) =>
    withRequestContext({ readOnly: false, staffUserId: userId }, fn);

  const register = (hospitalId: string, name: string, phoneE164: string, age: number | null = 40) =>
    withTenant(hospitalId, (tx) =>
      resolvePatientInTx(tx, { hospitalId, input: { kind: 'details', details: { name, phoneE164, age } } }),
    );

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug, mrn_prefix) values
      (${hospitalA}, ${HOSPITAL_NAME}, ${'pid-' + hospitalA.slice(0, 12)}, null),
      (${hospitalB}, ${HOSPITAL_NAME}, ${'pid-' + hospitalB.slice(0, 12)}, 'B')`;
    await admin`insert into branches (id, hospital_id, name) values (${branchA}, ${hospitalA}, 'Main')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorA}, ${hospitalA}, ${branchA}, 'Dr Joshi', 10)`;
    for (const [id, label] of [
      [ownerA, 'owner-a'],
      [deskA, 'desk-a'],
      [nurseA, 'nurse-a'],
      [ownerB, 'owner-b'],
    ]) {
      await admin`insert into users (id, email, password_hash, name)
        values (${id}, ${label + '-' + id + '@identity.test'}, 'x', ${label})`;
    }
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerA}, ${hospitalA}, 'owner'), (${deskA}, ${hospitalA}, 'receptionist'),
      (${nurseA}, ${hospitalA}, 'nurse'), (${ownerB}, ${hospitalB}, 'owner')`;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('gives a new patient a person, a valid QID and the first MRN, as registered here', async () => {
    const row = await register(hospitalB, 'Asha Kale', nextPhone());
    expect(isValidQid(row.qid!)).toBe(true);
    expect(row.personId).toBeTruthy();
    expect(row.mrn).toBe('B10001');
    expect(row.personLinkMethod).toBe('registered_here');
    expect(row.nameKey).toBe('asha kale');
    expect(row.birthYear).toBe(new Date().getFullYear() - 40);
  });

  it('finds a returning patient by phone and name key, whatever the case or punctuation', async () => {
    const p = nextPhone();
    const first = await register(hospitalA, 'Ramesh  Patil', p);
    const again = await register(hospitalA, 'ramesh patil.', p);
    expect(again.id).toBe(first.id);
    expect(again.qid).toBe(first.qid);
    expect(again.mrn).toBe(first.mrn);

    // Same phone, another name: another person (a family sharing a phone).
    const sister = await register(hospitalA, 'Sunita Patil', p);
    expect(sister.id).not.toBe(first.id);
    expect(sister.qid).not.toBe(first.qid);
  });

  it('creates a separate record when the desk says it is a different person', async () => {
    const p = nextPhone();
    const first = await register(hospitalA, 'Ravi More', p);
    const other = await withTenant(hospitalA, (tx) =>
      resolvePatientInTx(tx, {
        hospitalId: hospitalA,
        input: { kind: 'details', details: { name: 'RAVI MORE', phoneE164: p }, forceNew: true },
      }),
    );
    expect(other.id).not.toBe(first.id);
    expect(other.personId).not.toBe(first.personId);
  });

  it('gives a record created before 0039 its identity the first time it is used', async () => {
    // Such rows cannot exist once 0040 makes identity required.
    const [{ nullable }] = await admin`
      select is_nullable = 'YES' as nullable from information_schema.columns
      where table_name = 'patients' and column_name = 'person_id'`;
    if (!nullable) return;
    const p = nextPhone();
    const [legacy] = await admin`
      insert into patients (hospital_id, phone_e164, name, age) values (${hospitalA}, ${p}, 'Old Record', 61)
      returning id`;
    const row = await register(hospitalA, 'Old Record', p);
    expect(row.id).toBe(legacy.id);
    expect(isValidQid(row.qid!)).toBe(true);
    expect(row.mrn).toMatch(/^\d+$/);
  });

  it('issues distinct MRNs to concurrent registrations, with no gaps from committed rows', async () => {
    const rows = await Promise.all(
      Array.from({ length: 8 }, (_, i) => register(hospitalB, `Parallel Patient ${i}`, nextPhone())),
    );
    const numbers = rows.map((r) => Number(r.mrn!.slice(1))).sort((a, b) => a - b);
    expect(new Set(numbers).size).toBe(8);
    expect(numbers[7] - numbers[0]).toBe(7);
  });

  it('does not consume an MRN when the registration rolls back', async () => {
    const before = await register(hospitalB, 'Before Rollback', nextPhone());
    await expect(
      withTenant(hospitalB, async (tx) => {
        await resolvePatientInTx(tx, {
          hospitalId: hospitalB,
          input: { kind: 'details', details: { name: 'Rolled Back', phoneE164: nextPhone() } },
        });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');
    const after = await register(hospitalB, 'After Rollback', nextPhone());
    expect(Number(after.mrn!.slice(1))).toBe(Number(before.mrn!.slice(1)) + 1);
  });

  it('books a walk-in under the record already on file', async () => {
    const p = nextPhone();
    const onFile = await register(hospitalA, 'Walk In', p, 30);
    const { patient, appointment } = await createWalkIn({
      hospitalId: hospitalA,
      branchId: branchA,
      doctorId: doctorA,
      timezone: TZ,
      patient: { phoneE164: p, name: 'WALK-IN' },
      whatsappOptIn: false,
    });
    expect(patient.id).toBe(onFile.id);
    expect(patient.qid).toBe(onFile.qid);
    expect(appointment.patientId).toBe(onFile.id);
  });

  describe('a QID presented at another hospital', () => {
    it('links only after verification, to the canonical person, with a new local MRN', async () => {
      const home = await register(hospitalB, 'Meena Shinde', nextPhone(), 35);
      const birthYear = home.birthYear!;

      // No staff session (public booking, WhatsApp): refused by the database.
      await expect(
        verifyQidIdentityForLinking({ hospitalId: hospitalA, qid: home.qid!, name: 'Meena Shinde', birthYear }),
      ).rejects.toThrow();

      // A nurse is not in the role list.
      await expect(
        asStaff(nurseA, () =>
          verifyQidIdentityForLinking({ hospitalId: hospitalA, qid: home.qid!, name: 'Meena Shinde', birthYear }),
        ),
      ).rejects.toThrow();

      // Hospital B's owner cannot act as hospital A by setting the hospital.
      await expect(
        asStaff(ownerB, () =>
          verifyQidIdentityForLinking({ hospitalId: hospitalA, qid: home.qid!, name: 'Meena Shinde', birthYear }),
        ),
      ).rejects.toThrow();

      const typo = home.qid!.slice(0, -1) + (home.qid!.endsWith('0') ? '1' : '0');
      expect(
        await asStaff(deskA, () =>
          verifyQidIdentityForLinking({ hospitalId: hospitalA, qid: typo, name: 'Meena Shinde', birthYear }),
        ),
      ).toEqual({ result: 'invalid_qid' });

      const wrong = await asStaff(deskA, () =>
        verifyQidIdentityForLinking({ hospitalId: hospitalA, qid: home.qid!, name: 'Someone Else', birthYear }),
      );
      expect(wrong).toEqual({ result: 'no_match' });

      const match = await asStaff(deskA, () =>
        verifyQidIdentityForLinking({
          hospitalId: hospitalA,
          qid: home.qid!.toLowerCase().replace(/-/g, ' '),
          name: 'meena shinde',
          birthYear: birthYear + 1,
        }),
      );
      expect(match).toEqual({
        result: 'match',
        personId: home.personId,
        canonicalQid: home.qid,
        presentedQid: home.qid,
      });
      if (match.result !== 'match') throw new Error('unreachable');

      const linked = await asStaff(deskA, () =>
        withTenant(hospitalA, (tx) =>
          resolvePatientInTx(tx, {
            hospitalId: hospitalA,
            input: { kind: 'verified', ...match, details: { name: 'Meena Shinde', phoneE164: nextPhone(), age: 35 } },
            actorUserId: deskA,
          }),
        ),
      );
      expect(linked.hospitalId).toBe(hospitalA);
      expect(linked.personId).toBe(home.personId);
      expect(linked.qid).toBe(home.qid);
      expect(linked.personLinkMethod).toBe('qid_verified_at_desk');
      expect(linked.personLinkQid).toBe(home.qid);
      expect(linked.mrn).not.toBe(home.mrn);

      // Linking again finds the same record rather than creating another.
      const again = await asStaff(deskA, () =>
        withTenant(hospitalA, (tx) =>
          resolvePatientInTx(tx, {
            hospitalId: hospitalA,
            input: { kind: 'verified', ...match, details: { name: 'Meena', phoneE164: nextPhone() } },
          }),
        ),
      );
      expect(again.id).toBe(linked.id);
    });

    it('cannot be linked without a verification, even by knowing the person id', async () => {
      const home = await register(hospitalB, 'Kiran Jadhav', nextPhone());
      await expect(
        withTenant(hospitalA, (tx) =>
          resolvePatientInTx(tx, {
            hospitalId: hospitalA,
            input: {
              kind: 'verified',
              personId: home.personId!,
              canonicalQid: home.qid!,
              presentedQid: home.qid!,
              details: { name: 'Kiran Jadhav', phoneE164: nextPhone() },
            },
          }),
        ),
      ).rejects.toThrow();

      // Nor by writing the row directly as the app role.
      await expect(
        withTenant(hospitalA, (tx) =>
          tx.insert(patients).values({
            hospitalId: hospitalA,
            phoneE164: nextPhone(),
            name: 'Kiran Jadhav',
            personId: home.personId,
            qid: home.qid,
            mrn: '99999',
            personLinkMethod: 'registered_here',
          }),
        ),
      ).rejects.toThrow();
    });
  });

  it('keeps persons out of the app role’s reach entirely', async () => {
    await expect(withTenant(hospitalA, (tx) => tx.execute(sql`select count(*) from persons`))).rejects.toThrow();
    await expect(
      withTenant(hospitalA, (tx) => tx.execute(sql`select public.minimize_person(gen_random_uuid())`)),
    ).rejects.toThrow();
  });

  it('refuses a forged name key and a changed MRN', async () => {
    const row = await register(hospitalA, 'Gauri Desai', nextPhone());
    const [forged] = await withTenant(hospitalA, (tx) =>
      tx
        .update(patients)
        .set({ nameKey: 'forged' })
        .where(sql`${patients.id} = ${row.id}`)
        .returning({ nameKey: patients.nameKey }),
    );
    expect(forged.nameKey).toBe('gauri desai');
    await expect(
      withTenant(hospitalA, (tx) => tx.update(patients).set({ mrn: '1' }).where(sql`${patients.id} = ${row.id}`)),
    ).rejects.toThrow();
  });

  it('lets only the owner correct platform identity data, keeping the QID', async () => {
    const row = await register(hospitalA, 'Prakash Rao', nextPhone(), 50);
    await expect(
      asStaff(deskA, () =>
        correctPersonIdentity({
          hospitalId: hospitalA,
          patientId: row.id,
          name: 'Prakash S Rao',
          gender: 'M',
          birthYear: row.birthYear,
          reason: 'spelling',
        }),
      ),
    ).rejects.toBeInstanceOf(PatientIdentityError);
    await asStaff(ownerA, () =>
      correctPersonIdentity({
        hospitalId: hospitalA,
        patientId: row.id,
        name: 'Prakash S Rao',
        gender: 'M',
        birthYear: row.birthYear,
        reason: 'spelling',
      }),
    );
    const [person] = await admin`select qid, identity_name, identity_name_key from persons where id = ${row.personId}`;
    expect(person).toMatchObject({ qid: row.qid, identity_name: 'Prakash S Rao', identity_name_key: 'prakash s rao' });
    const corrections = await admin`select field from person_identity_corrections where person_id = ${row.personId}`;
    expect(corrections.map((c) => c.field).sort()).toEqual(['gender', 'name']);
  });

  it('searches this hospital only, by QID, MRN, phone and name', async () => {
    const p = nextPhone();
    const row = await register(hospitalA, 'Vaishali Kulkarni', p);
    const elsewhere = await register(hospitalB, 'Vaishali Kulkarni', nextPhone());

    for (const query of [row.qid!, row.qid!.replace(/-/g, '').toLowerCase(), row.mrn!, p.slice(-6), 'vaish', 'kulkar']) {
      const hits = await searchHospitalPatients({ hospitalId: hospitalA, query });
      expect(hits.map((h) => h.patientId), query).toContain(row.id);
      expect(hits.map((h) => h.patientId), query).not.toContain(elsewhere.id);
    }
    expect(await searchHospitalPatients({ hospitalId: hospitalA, query: elsewhere.qid! })).toEqual([]);
  });

  it('resolves a group to the active record and the records merged into it', async () => {
    const survivor = await register(hospitalA, 'Group Survivor', nextPhone());
    const duplicate = await register(hospitalA, 'Group Duplicate', nextPhone());
    await withTenant(hospitalA, async (tx) => {
      const [merge] = await tx.execute<{ id: string }>(sql`
        insert into patient_merges (hospital_id, from_patient_id, to_patient_id, reason)
        values (${hospitalA}::uuid, ${duplicate.id}::uuid, ${survivor.id}::uuid, 'duplicate') returning id`);
      await tx.execute(sql`select set_config('app.patient_merge_id', ${merge.id}, true)`);
      await tx.execute(sql`update patients set merged_into_id = ${survivor.id}::uuid, merged_at = now() where id = ${duplicate.id}::uuid`);
    });
    const ids = await withTenant(hospitalA, (tx) => patientGroupIds(tx, duplicate.id));
    expect(ids.sort()).toEqual([survivor.id, duplicate.id].sort());

    // A hit on the merged record returns the survivor, labelled.
    const hits = await searchHospitalPatients({ hospitalId: hospitalA, query: duplicate.mrn! });
    expect(hits).toEqual([expect.objectContaining({ patientId: survivor.id, matchedVia: 'merged_record' })]);

    // New activity goes to the survivor: the resolver follows the merge.
    const resolved = await withTenant(hospitalA, (tx) =>
      resolvePatientInTx(tx, { hospitalId: hospitalA, input: { kind: 'existing', patientId: duplicate.id } }),
    );
    expect(resolved.id).toBe(survivor.id);
  });
});
