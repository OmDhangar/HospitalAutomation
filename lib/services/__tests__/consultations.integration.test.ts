import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import {
  clinicalNotes,
  consultationDrafts,
  diagnoses,
  prescriptionItems,
  prescriptions,
  recordAccessLogs,
} from '@/lib/db/schema';
import {
  ConsultationError,
  DraftConflictError,
  getPatientHistory,
  getPrescriptionForPrint,
  openConsultation,
  saveConsultation,
  saveDraft,
  type Actor,
} from '@/lib/services/consultations';
import { setDoctorUser } from '@/lib/services/hospital';
import { createMedicine, setMedicineActive, updateMedicine } from '@/lib/services/medicines';
import { createWalkIn } from '@/lib/services/queue';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);

const TZ = 'Asia/Kolkata';
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Consultation Test Hospital';

/** Asserts on the whole error chain: Drizzle keeps the Postgres error as the cause. */
const rejectsWith = async (work: Promise<unknown>, pattern: RegExp) => {
  const chain: string[] = [];
  try {
    await work;
  } catch (err) {
    for (let e = err as { message?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
      if (e.message) chain.push(e.message);
    }
    expect(chain.join(' | ')).toMatch(pattern);
    return;
  }
  throw new Error(`expected a rejection matching ${pattern}, but it succeeded`);
};

describe.skipIf(!enabled)('OPD consultations', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 4 }) : (null as never);

  let hospitalId: string;
  let branchId: string;
  let doctorId: string;
  let doctor: Actor;
  let owner: Actor;
  let paracetamol: string;
  let azithromycin: string;
  let walkIns = 0;

  const seedHospital = async () => {
    const h = uuid();
    const b = uuid();
    const d = uuid();
    await admin`insert into hospitals (id, name, slug) values (${h}, ${HOSPITAL_NAME}, ${'ct-' + h.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${b}, ${h}, 'Main')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${d}, ${h}, ${b}, 'Dr Sharma', 10)
    `;
    return { hospitalId: h, branchId: b, doctorId: d };
  };

  const seedUser = async (role: 'doctor' | 'owner') => {
    const id = uuid();
    await admin`
      insert into users (id, email, password_hash, name)
      values (${id}, ${`${role}-${id}@consultation.test`}, 'x', ${role})
    `;
    await admin`
      insert into staff_memberships (user_id, hospital_id, role, active)
      values (${id}, ${hospitalId}, ${role}, true)
    `;
    return { userId: id, role } as Actor;
  };

  /** A new visit for the same patient (the day advances so the token is new). */
  const visit = async () => {
    walkIns += 1;
    const { appointment } = await createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      patient: { phoneE164: '+919700000001', name: 'Rahul Patil', age: 42 },
      whatsappOptIn: false,
      now: new Date(Date.now() + walkIns * 86_400_000),
    });
    const view = await openConsultation({ hospitalId, appointmentId: appointment.id, actor: doctor });
    return view.encounterId;
  };

  const rx = (overrides: Record<string, unknown> = {}) => ({
    diagnosis: 'Viral fever',
    notes: 'Fever 3 days',
    items: [
      { medicineId: paracetamol, dose: '1 tab', frequency: '1-0-1', durationDays: 5, instructions: 'After food' },
    ],
    advice: 'Plenty of fluids',
    followUpOn: null,
    ...overrides,
  });

  beforeEach(async () => {
    ({ hospitalId, branchId, doctorId } = await seedHospital());
    doctor = await seedUser('doctor');
    owner = await seedUser('owner');
    await setDoctorUser({ hospitalId, doctorId, userId: doctor.userId });
    paracetamol = (
      await createMedicine({
        hospitalId,
        input: { name: 'Paracetamol', strength: '500 mg', form: 'tablet' },
        actorUserId: owner.userId,
      })
    ).id;
    azithromycin = (
      await createMedicine({
        hospitalId,
        input: { name: 'Azithromycin', strength: '500 mg', form: 'tablet' },
        actorUserId: owner.userId,
      })
    ).id;
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@consultation.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('lets the linked doctor write, and tells anyone else why they cannot', async () => {
    walkIns += 1;
    const { appointment } = await createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      patient: { phoneE164: '+919700000002', name: 'Sita Devi' },
      whatsappOptIn: false,
      now: new Date(Date.now() + walkIns * 86_400_000),
    });

    const asDoctor = await openConsultation({ hospitalId, appointmentId: appointment.id, actor: doctor });
    expect(asDoctor.canWrite).toBe(true);

    const asOwner = await openConsultation({ hospitalId, appointmentId: appointment.id, actor: owner });
    expect(asOwner.canWrite).toBe(false);
    expect(asOwner.cannotWriteReason).toContain('Dr Sharma');

    await expect(
      saveConsultation({ hospitalId, encounterId: asOwner.encounterId, input: rx(), actor: owner }),
    ).rejects.toBeInstanceOf(ConsultationError);
  });

  it('writes diagnosis, notes and prescription together, and clears the draft', async () => {
    const encounterId = await visit();
    await saveDraft({
      hospitalId,
      encounterId,
      content: { ...rx(), items: [] },
      expectedVersion: null,
      actor: doctor,
    });

    const { prescriptionId } = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });
    expect(prescriptionId).not.toBeNull();

    const counts = await withTenant(
      hospitalId,
      async (tx) => ({
        diagnoses: (await tx.select().from(diagnoses).where(eq(diagnoses.encounterId, encounterId))).length,
        notes: (await tx.select().from(clinicalNotes).where(eq(clinicalNotes.encounterId, encounterId))).length,
        items: (await tx.select().from(prescriptionItems).where(eq(prescriptionItems.prescriptionId, prescriptionId!))).length,
        drafts: (await tx.select().from(consultationDrafts).where(eq(consultationDrafts.encounterId, encounterId))).length,
      }),
      { clinical: true },
    );
    expect(counts).toEqual({ diagnoses: 1, notes: 1, items: 1, drafts: 0 });
  });

  it('writes nothing at all when one medicine is refused', async () => {
    const encounterId = await visit();
    await setMedicineActive({ hospitalId, medicineId: azithromycin, active: false, actorUserId: owner.userId });

    const input = rx({
      items: [
        { medicineId: paracetamol, dose: '1 tab', frequency: '1-0-1', durationDays: 5, instructions: '' },
        { medicineId: azithromycin, dose: '1 tab', frequency: '1-0-0', durationDays: 3, instructions: '' },
      ],
    });
    await rejectsWith(saveConsultation({ hospitalId, encounterId, input, actor: doctor }), /no longer offered/);

    const written = await withTenant(
      hospitalId,
      (tx) => tx.select().from(diagnoses).where(eq(diagnoses.encounterId, encounterId)),
      { clinical: true },
    );
    expect(written).toHaveLength(0);
  });

  it('prints what was prescribed, even after the catalogue renames the medicine', async () => {
    const encounterId = await visit();
    const { prescriptionId } = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });

    await updateMedicine({
      hospitalId,
      medicineId: paracetamol,
      input: { name: 'Paracetamol Extra', strength: '500 mg', form: 'tablet' },
      actorUserId: owner.userId,
    });

    const printed = await getPrescriptionForPrint({ hospitalId, prescriptionId: prescriptionId!, actor: doctor });
    expect(printed.items[0].label).toBe('Paracetamol 500 mg tablet');
  });

  it('keeps an old prescription readable after its medicine is removed', async () => {
    const encounterId = await visit();
    const { prescriptionId } = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });
    await setMedicineActive({ hospitalId, medicineId: paracetamol, active: false, actorUserId: owner.userId });

    const printed = await getPrescriptionForPrint({ hospitalId, prescriptionId: prescriptionId!, actor: doctor });
    expect(printed.items).toHaveLength(1);

    // …and it cannot be prescribed again.
    const next = await visit();
    await rejectsWith(saveConsultation({ hospitalId, encounterId: next, input: rx(), actor: doctor }), /no longer offered/);
  });

  it('revises by superseding, and does not create a version when nothing changed', async () => {
    const encounterId = await visit();
    const first = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });
    const again = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });
    expect(again.prescriptionId).toBe(first.prescriptionId);

    const revised = await saveConsultation({
      hospitalId,
      encounterId,
      input: rx({
        items: [{ medicineId: paracetamol, dose: '2 tab', frequency: '1-0-1', durationDays: 5, instructions: '' }],
      }),
      actor: doctor,
    });
    expect(revised.prescriptionId).not.toBe(first.prescriptionId);

    const all = await withTenant(
      hospitalId,
      (tx) => tx.select().from(prescriptions).where(eq(prescriptions.encounterId, encounterId)),
      { clinical: true },
    );
    const byId = new Map(all.map((p) => [p.id, p]));
    expect(byId.get(first.prescriptionId!)?.status).toBe('superseded');
    expect(byId.get(revised.prescriptionId!)?.status).toBe('final');
    expect(byId.get(revised.prescriptionId!)?.supersedesPrescriptionId).toBe(first.prescriptionId);

    const printedOld = await getPrescriptionForPrint({
      hospitalId,
      prescriptionId: first.prescriptionId!,
      actor: doctor,
    });
    expect(printedOld.superseded).toBe(true);
    expect(printedOld.items[0].dose).toBe('1 tab');
  });

  it('refuses to edit a saved prescription or slip a line into it later', async () => {
    const encounterId = await visit();
    const { prescriptionId } = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });

    await rejectsWith(
      withTenant(
        hospitalId,
        (tx) => tx.update(prescriptions).set({ advice: 'changed' }).where(eq(prescriptions.id, prescriptionId!)),
        { clinical: true },
      ),
      /cannot be changed/,
    );
    await rejectsWith(
      withTenant(
        hospitalId,
        (tx) => tx.update(prescriptionItems).set({ dose: '10 tab' }).where(eq(prescriptionItems.prescriptionId, prescriptionId!)),
        { clinical: true },
      ),
      /cannot be edited/,
    );
    await rejectsWith(
      withTenant(
        hospitalId,
        (tx) =>
          tx.insert(prescriptionItems).values({
            hospitalId,
            prescriptionId: prescriptionId!,
            medicineId: azithromycin,
            medicineName: 'Azithromycin',
            dose: '1 tab',
            frequency: '1-0-0',
            sortOrder: 9,
          }),
        { clinical: true },
      ),
      /already saved/,
    );
  });

  it('hides clinical rows without the clinical key, and from support sessions even with it', async () => {
    const encounterId = await visit();
    await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });

    const plain = await withTenant(hospitalId, (tx) => tx.select().from(prescriptions));
    expect(plain).toHaveLength(0);

    const support = await withTenant(hospitalId, (tx) => tx.select().from(prescriptions), {
      clinical: true,
      readOnly: true,
    });
    expect(support).toHaveLength(0);

    const clinical = await withTenant(hospitalId, (tx) => tx.select().from(prescriptions), { clinical: true });
    expect(clinical).toHaveLength(1);
  });

  it('keeps one hospital out of another hospital\'s records', async () => {
    const encounterId = await visit();
    const { prescriptionId } = await saveConsultation({ hospitalId, encounterId, input: rx(), actor: doctor });

    const other = await seedHospital();
    await rejectsWith(
      getPrescriptionForPrint({ hospitalId: other.hospitalId, prescriptionId: prescriptionId!, actor: doctor }),
      /not found/,
    );
  });

  it('refuses a draft saved over a newer one from another screen', async () => {
    const encounterId = await visit();
    const draft = { ...rx(), items: [] };
    const { version } = await saveDraft({ hospitalId, encounterId, content: draft, expectedVersion: null, actor: doctor });
    await saveDraft({ hospitalId, encounterId, content: draft, expectedVersion: version, actor: doctor });

    await expect(
      saveDraft({ hospitalId, encounterId, content: draft, expectedVersion: version, actor: doctor }),
    ).rejects.toBeInstanceOf(DraftConflictError);
  });

  it('builds history from the records, and logs who looked', async () => {
    const earlier = await visit();
    await saveConsultation({ hospitalId, encounterId: earlier, input: rx(), actor: doctor });
    const today = await visit();

    const history = await getPatientHistory({ hospitalId, encounterId: today, actor: owner });
    expect(history).toHaveLength(1);
    expect(history[0].diagnosis).toBe('Viral fever');
    expect(history[0].prescription?.items[0].label).toBe('Paracetamol 500 mg tablet');

    const logs = await withTenant(hospitalId, (tx) =>
      tx.select().from(recordAccessLogs).where(eq(recordAccessLogs.encounterId, today)),
    );
    expect(logs.map((l) => l.action)).toEqual(['view_history']);
  });

  it('refuses to link one login to two doctors', async () => {
    const second = uuid();
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${second}, ${hospitalId}, ${branchId}, 'Dr Kulkarni', 10)
    `;
    await expect(setDoctorUser({ hospitalId, doctorId: second, userId: doctor.userId })).rejects.toThrow(
      /already linked to Dr Sharma/,
    );
  });
});
