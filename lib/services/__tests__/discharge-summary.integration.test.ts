import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { parseSummary } from '@/lib/domain/discharge-summary';
import { parseNote } from '@/lib/domain/notes';
import { parseOrder } from '@/lib/domain/mar';
import { parseMedRecItem } from '@/lib/domain/medrec';
import { hashPassword } from '@/lib/security/password';
import { createDirectAdmission } from '@/lib/services/admissions';
import { countersignSummary, finaliseSummary, getSummaryView, listSummariesToSign, refreshDraft, saveDraft } from '@/lib/services/discharge-summary';
import { createWard } from '@/lib/services/ipd-config';
import { createOrder } from '@/lib/services/mar';
import { addMedRecItem, decideMedRecItem, prepareDischargeList, signMedRec } from '@/lib/services/medrec';
import { writeNote } from '@/lib/services/notes';

/**
 * The discharge summary against a real database (IPD sheets plan B5,
 * migration 0053): the draft built from the record (case sheet, treatment
 * card, reconciled medicines), saved outside the record, finalised as
 * numbered versions — signed by the doctor named, or countersigned by them
 * only — superseded with a reason; the guards.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Summary Test Hospital';
const TZ = 'Asia/Kolkata';

describe.skipIf(!enabled)('discharge summary (0053)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const [doctorA, doctorB] = [uuid(), uuid()];
  const [ownerUser, doctorUserA, doctorUserB, nurseUser] = [uuid(), uuid(), uuid(), uuid()];
  const augmentin = uuid();
  let admissionId = '';

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'ds-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    const hash = await hashPassword('correct horse battery');
    await admin`insert into users (id, email, password_hash, name, last_login_at) values
      (${ownerUser}, ${'o-' + ownerUser + '@ds.test'}, ${hash}, 'Owner', now()),
      (${doctorUserA}, ${'a-' + doctorUserA + '@ds.test'}, ${hash}, 'Dr Bhosale', now()),
      (${doctorUserB}, ${'b-' + doctorUserB + '@ds.test'}, ${hash}, 'Dr Inamdar', now()),
      (${nurseUser}, ${'n-' + nurseUser + '@ds.test'}, ${hash}, 'Sister Neha', now())`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerUser}, ${hospitalId}, 'owner'), (${doctorUserA}, ${hospitalId}, 'doctor'), (${doctorUserB}, ${hospitalId}, 'doctor'), (${nurseUser}, ${hospitalId}, 'nurse')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes) values
      (${doctorA}, ${hospitalId}, ${branchId}, 'Dr Bhosale', ${doctorUserA}, 10),
      (${doctorB}, ${hospitalId}, ${branchId}, 'Dr Inamdar', ${doctorUserB}, 10)`;
    await admin`insert into medicines (id, hospital_id, name, strength, form, unit, selling_price_paise) values
      (${augmentin}, ${hospitalId}, 'Augmentin', '625 mg', 'tablet', 'tablet', 4000)`;
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward D', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerUser });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId: doctorA,
      patient: { phoneE164: '+919300000055', name: 'Ganesh Pawar' },
      bedId: bed.id as string,
      extras: { reason: 'Fever with cough' },
      actorUserId: ownerUser,
    }));
    await writeNote({
      hospitalId, admissionId,
      input: parseNote({ kind: 'admission', caseOf: 'Lower respiratory tract infection', complaints: [{ text: 'Cough', duration: '1 week' }], vitals: { pulse: '96' }, systemicExam: { rs: 'Crepts right base' } }),
      seenByDoctorId: doctorA, actorUserId: doctorUserA, mayTranscribe: false, chart: true, clientId: uuid(),
    });
    await createOrder({
      hospitalId, admissionId,
      input: parseOrder({ kind: 'medicine', medicineId: augmentin, dose: '1 tab', route: 'oral', frequency: 'BD' }),
      orderingDoctorId: doctorA, clientId: uuid(), actor: { userId: doctorUserA, channel: 'personal', wardDeviceId: null }, mayTranscribe: false,
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['discharge_summaries', 'discharge_summary_drafts', 'med_rec_signoffs', 'med_rec_items', 'ipd_notes', 'chart_entries', 'treatment_orders']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@ds.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('drafts from the record, and keeps the draft outside the record', async () => {
    const view = await getSummaryView({ hospitalId, admissionId, timezone: TZ });
    expect(view.draftSaved).toBeNull();
    expect(view.current).toBeNull();
    expect(view.doctorId).toBe(doctorA);
    expect(view.draft).toMatchObject({ diagnosis: 'Lower respiratory tract infection', complaints: 'Cough × 1 week', medicinesUnreconciled: true });
    expect(view.draft.findings).toContain('RS: Crepts right base');
    expect(view.draft.treatmentGiven).toContain('Augmentin 625 mg tablet');
    await saveDraft({ hospitalId, admissionId, content: { ...view.draft, course: 'Improved on oral antibiotics.' }, actorUserId: nurseUser });
    expect((await getSummaryView({ hospitalId, admissionId, timezone: TZ })).draftSaved?.by).toBe('Sister Neha');

    // Reconcile the discharge medicines, then fill again: the medicines come from the reconciliation, the course stays.
    await addMedRecItem({ hospitalId, admissionId, phase: 'admission', input: parseMedRecItem({ name: 'Tab Glimepiride 1 mg' }), source: 'patient', clientId: uuid(), actorUserId: nurseUser });
    const [home] = (await admin`select id from med_rec_items where admission_id = ${admissionId} and phase = 'admission'`) as unknown as { id: string }[];
    await decideMedRecItem({ hospitalId, itemId: home.id, decision: 'continue', note: null, actorUserId: doctorUserA });
    await prepareDischargeList({ hospitalId, admissionId, actorUserId: nurseUser });
    for (const item of await admin`select id from med_rec_items where admission_id = ${admissionId} and phase = 'discharge'`) {
      await decideMedRecItem({ hospitalId, itemId: item.id as string, decision: 'continue', note: null, actorUserId: doctorUserA });
    }
    await signMedRec({ hospitalId, admissionId, phase: 'discharge', noneAtHome: false, actorUserId: doctorUserA });
    const saved = (await getSummaryView({ hospitalId, admissionId, timezone: TZ })).draft;
    const refreshed = await refreshDraft({ hospitalId, admissionId, current: saved, timezone: TZ, actorUserId: nurseUser });
    expect(refreshed.course).toBe('Improved on oral antibiotics.');
    expect(refreshed.medicinesUnreconciled).toBe(false);
    expect(refreshed.medicines.map((m) => m.name).sort()).toEqual(['Augmentin 625 mg tablet', 'Tab Glimepiride 1 mg']);
  });

  it('finalised by a nurse, it waits for the named doctor’s signature, and no one else’s', async () => {
    const content = parseSummary({ ...(await getSummaryView({ hospitalId, admissionId, timezone: TZ })).draft }, { final: true });
    await expect(finaliseSummary({ hospitalId, admissionId, content, doctorId: doctorA, changeReason: null, actorUserId: nurseUser, mayTranscribe: false, clientId: uuid() })).rejects.toThrow(/Only the doctor named/);
    const clientId = uuid();
    const v1 = await finaliseSummary({ hospitalId, admissionId, content, doctorId: doctorA, changeReason: null, actorUserId: nurseUser, mayTranscribe: true, clientId });
    expect(v1).toMatchObject({ version: 1, signed: false, repeat: false });
    expect((await finaliseSummary({ hospitalId, admissionId, content, doctorId: doctorA, changeReason: null, actorUserId: nurseUser, mayTranscribe: true, clientId })).repeat).toBe(true);
    expect((await getSummaryView({ hospitalId, admissionId, timezone: TZ })).draftSaved).toBeNull();
    expect((await listSummariesToSign({ hospitalId, userId: doctorUserA })).map((s) => s.id)).toEqual([v1.id]);
    await expect(countersignSummary({ hospitalId, summaryId: v1.id, actorUserId: doctorUserB })).rejects.toThrow(/Only the doctor named/);
    await countersignSummary({ hospitalId, summaryId: v1.id, actorUserId: doctorUserA });
    const view = await getSummaryView({ hospitalId, admissionId, timezone: TZ });
    expect(view.current).toMatchObject({ version: 1, signedBy: 'Dr Bhosale', transcribed: true });
  });

  it('a correction is a new version with a reason, signed at once by the doctor named', async () => {
    const view = await getSummaryView({ hospitalId, admissionId, timezone: TZ });
    const content = parseSummary({ ...view.draft, followUp: 'Review after 5 days with chest X-ray.' }, { final: true });
    await expect(finaliseSummary({ hospitalId, admissionId, content, doctorId: doctorA, changeReason: null, actorUserId: doctorUserA, mayTranscribe: false, clientId: uuid() })).rejects.toThrow(/what changed/);
    const v2 = await finaliseSummary({ hospitalId, admissionId, content, doctorId: doctorA, changeReason: 'Follow-up date changed', actorUserId: doctorUserA, mayTranscribe: false, clientId: uuid() });
    expect(v2).toMatchObject({ version: 2, signed: true });
    const after = await getSummaryView({ hospitalId, admissionId, timezone: TZ });
    expect(after.versions.map((v) => [v.version, v.changeReason])).toEqual([
      [2, 'Follow-up date changed'],
      [1, null],
    ]);
    expect(after.draft.followUp).toBe('Review after 5 days with chest X-ray.');
  });

  it('holds finalised versions in the database', async () => {
    const [v] = await admin`select id from discharge_summaries where admission_id = ${admissionId} and version = 1`;
    await expect(admin`update discharge_summaries set content = '{}'::jsonb where id = ${v.id}`).rejects.toThrow(/cannot be edited/);
    await expect(admin`delete from discharge_summaries where id = ${v.id}`).rejects.toThrow(/never deleted/);
    await expect(admin`update discharge_summaries set signed_at = now() where id = ${v.id}`).rejects.toThrow(/already signed/);
    const [{ n }] = await admin`select count(*)::int as n from acct_events where hospital_id = ${hospitalId} and object_type = 'discharge_summary'`;
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
