import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { parseAllergy } from '@/lib/domain/allergy';
import { depositAlertSettingsFrom } from '@/lib/domain/discharge-bill';
import { parseOrder } from '@/lib/domain/mar';
import { parseMedRecItem } from '@/lib/domain/medrec';
import { hashPassword } from '@/lib/security/password';
import { createDirectAdmission } from '@/lib/services/admissions';
import { allergyStatuses, getAllergies, recordAllergy, reviewAllergies, strikeOutAllergy } from '@/lib/services/allergy';
import { listDepositAlerts } from '@/lib/services/deposit-alerts';
import { createWard } from '@/lib/services/ipd-config';
import { AllergyMatchError, createOrder, getTreatmentCard, recordGive, type Actor } from '@/lib/services/mar';
import { addMedRecItem, decideMedRecItem, getMedRec, prepareDischargeList, signMedRec } from '@/lib/services/medrec';
import { chartDayOf } from '@/lib/domain/tpr';

/**
 * Allergies, medication reconciliation and deposit alerts against a real
 * database (IPD sheets plan B2, migration 0051): allergies per patient with
 * the check on a medicine line (a reason to go ahead, kept on the line);
 * "none known" refused while one is on record; the reconciliation lists, the
 * doctor's decisions and sign-off; the discharge list started from the card;
 * deposit alerts; and the database guards.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Allergy Test Hospital';
const TZ = 'Asia/Kolkata';

describe.skipIf(!enabled)('allergies, medication reconciliation, deposit alerts (0051)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const [ownerUser, doctorUser, nurseUser] = [uuid(), uuid(), uuid()];
  const [augmentin, paracetamol, ceftriaxone] = [uuid(), uuid(), uuid()];
  let admissionId = '';
  let patientId = '';

  const doctor: Actor = { userId: doctorUser, channel: 'personal', wardDeviceId: null };
  const order = (medicineId: string, extra: Partial<Parameters<typeof createOrder>[0]> = {}) =>
    createOrder({
      hospitalId,
      admissionId,
      input: parseOrder({ kind: 'medicine', medicineId, dose: '1 tab', route: 'oral', frequency: 'BD' }),
      orderingDoctorId: doctorId,
      clientId: uuid(),
      actor: doctor,
      mayTranscribe: false,
      ...extra,
    });

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'al-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    const hash = await hashPassword('correct horse battery');
    await admin`insert into users (id, email, password_hash, name, last_login_at) values
      (${ownerUser}, ${'o-' + ownerUser + '@al.test'}, ${hash}, 'Owner', now()),
      (${doctorUser}, ${'d-' + doctorUser + '@al.test'}, ${hash}, 'Dr Joshi', now()),
      (${nurseUser}, ${'n-' + nurseUser + '@al.test'}, ${hash}, 'Sister Rekha', now())`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerUser}, ${hospitalId}, 'owner'), (${doctorUser}, ${hospitalId}, 'doctor'), (${nurseUser}, ${hospitalId}, 'nurse')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Joshi', ${doctorUser}, 10)`;
    await admin`insert into medicines (id, hospital_id, name, generic_name, strength, form, unit, selling_price_paise) values
      (${augmentin}, ${hospitalId}, 'Augmentin', 'Amoxicillin + Clavulanic acid', '625 mg', 'tablet', 'tablet', 4000),
      (${paracetamol}, ${hospitalId}, 'Paracetamol', null, '500 mg', 'tablet', 'tablet', 200),
      (${ceftriaxone}, ${hospitalId}, 'Ceftriaxone', null, '1 g', 'injection', 'vial', 9000)`;
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward B', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerUser });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919300000099', name: 'Shobha Patil' },
      bedId: bed.id as string,
      extras: { depositPaise: 10_000 },
      actorUserId: ownerUser,
    }));
    [{ patient_id: patientId }] = (await admin`select patient_id from admissions where id = ${admissionId}`) as unknown as { patient_id: string }[];
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['med_rec_signoffs', 'med_rec_items', 'patient_allergy_reviews', 'patient_allergies', 'mar_administrations', 'treatment_orders']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@al.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('records allergies per patient; "none known" only when none is on record', async () => {
    expect((await getAllergies(hospitalId, patientId)).status).toEqual({ kind: 'not_asked' });
    await reviewAllergies({ hospitalId, patientId, admissionId, outcome: 'nkda', note: null, actorUserId: nurseUser });
    expect((await getAllergies(hospitalId, patientId)).status.kind).toBe('nkda');

    const clientId = uuid();
    const first = await recordAllergy({ hospitalId, patientId, admissionId, input: parseAllergy({ substance: 'Penicillin', severity: 'severe', reaction: 'Swelling of face' }), clientId, actorUserId: nurseUser });
    expect(await recordAllergy({ hospitalId, patientId, admissionId, input: parseAllergy({ substance: 'Penicillin' }), clientId, actorUserId: nurseUser })).toEqual({ id: first.id, repeat: true });
    await expect(recordAllergy({ hospitalId, patientId, admissionId, input: parseAllergy({ substance: 'penicillin' }), clientId: uuid(), actorUserId: nurseUser })).rejects.toThrow(/already recorded/);
    await recordAllergy({ hospitalId, patientId, admissionId, input: parseAllergy({ substance: 'Peanuts', category: 'food' }), clientId: uuid(), actorUserId: nurseUser });
    const view = await getAllergies(hospitalId, patientId);
    expect(view.allergies.map((a) => [a.substance, a.drugClass, a.severity])).toEqual([
      ['Penicillin', 'penicillins', 'severe'],
      ['Peanuts', null, 'unknown'],
    ]);
    expect(view.status).toEqual({ kind: 'allergies', count: 2, severe: true });
    expect((await allergyStatuses(hospitalId, [patientId])).get(patientId)?.kind).toBe('allergies');
    await expect(reviewAllergies({ hospitalId, patientId, admissionId, outcome: 'nkda', note: null, actorUserId: nurseUser })).rejects.toThrow(/Strike it out first/);
    await expect(reviewAllergies({ hospitalId, patientId, admissionId, outcome: 'unable', note: null, actorUserId: nurseUser })).rejects.toThrow(/why/);
  });

  it('asks the doctor why before writing a medicine that matches an allergy, and keeps the reason', async () => {
    let caught: unknown;
    try {
      await order(augmentin);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AllergyMatchError);
    expect((caught as AllergyMatchError).matches.map((m) => m.why)).toEqual(['same class: Penicillins']);

    const written = await order(augmentin, { allergyOverride: 'Skin test negative; no alternative available' });
    expect(written.allergyMatches).toEqual(['Penicillin (severe; same class: Penicillins)']);
    const card = await getTreatmentCard({ hospitalId, admissionId, day: chartDayOf(new Date(), TZ), timezone: TZ });
    expect(card.orders.find((o) => o.id === written.orderId)).toMatchObject({
      allergyMatches: ['Penicillin (severe; same class: Penicillins)'],
      allergyOverrideReason: 'Skin test negative; no alternative available',
    });
    const [audit] = await admin`select action from audit_logs where object_id = ${written.orderId}`;
    expect(audit.action).toBe('mar.allergy_override');

    // No match: no question. Check switched off: no question either.
    expect((await order(paracetamol)).allergyMatches).toEqual([]);
    expect((await order(augmentin, { allergyCheck: false })).allergyMatches).toEqual([]);

    // Struck out: no longer matched.
    const [penicillin] = (await getAllergies(hospitalId, patientId)).allergies;
    await strikeOutAllergy({ hospitalId, allergyId: penicillin.id, reason: 'Tested: not allergic', actorUserId: doctorUser });
    expect((await order(augmentin)).allergyMatches).toEqual([]);
  });

  it('reconciles home medicines at admission, decided and completed by a doctor', async () => {
    const add = (name: string) =>
      addMedRecItem({ hospitalId, admissionId, phase: 'admission', input: parseMedRecItem({ name, dose: '1 tab', frequency: 'OD' }), source: 'patient', clientId: uuid(), actorUserId: nurseUser });
    const metformin = await add('Tab Metformin 500 mg');
    const amlodipine = await add('Tab Amlodipine 5 mg');
    await expect(signMedRec({ hospitalId, admissionId, phase: 'admission', noneAtHome: false, actorUserId: doctorUser })).rejects.toThrow(/2 medicines have no decision/);
    await expect(decideMedRecItem({ hospitalId, itemId: metformin.id, decision: 'hold', note: null, actorUserId: doctorUser })).rejects.toThrow(/why/);
    await decideMedRecItem({ hospitalId, itemId: metformin.id, decision: 'hold', note: 'NPO for surgery; on insulin sliding scale', actorUserId: doctorUser });
    await decideMedRecItem({ hospitalId, itemId: amlodipine.id, decision: 'continue', note: null, actorUserId: doctorUser });
    await expect(decideMedRecItem({ hospitalId, itemId: amlodipine.id, decision: 'new', note: null, actorUserId: doctorUser })).rejects.toThrow(/Choose a decision/);
    await expect(signMedRec({ hospitalId, admissionId, phase: 'admission', noneAtHome: false, actorUserId: nurseUser })).rejects.toThrow(/doctor/);
    await expect(signMedRec({ hospitalId, admissionId, phase: 'admission', noneAtHome: true, actorUserId: doctorUser })).rejects.toThrow(/untick/);
    await signMedRec({ hospitalId, admissionId, phase: 'admission', noneAtHome: false, actorUserId: doctorUser });
    const view = await getMedRec(hospitalId, admissionId);
    expect(view.admission.signoff).toMatchObject({ doctorName: 'Dr Joshi', items: 2 });
    expect(view.admission.items.map((i) => [i.name, i.decision])).toEqual([
      ['Tab Metformin 500 mg', 'hold'],
      ['Tab Amlodipine 5 mg', 'continue'],
    ]);
  });

  it('starts the discharge list from the card and the home medicines, once', async () => {
    const { added } = await prepareDischargeList({ hospitalId, admissionId, actorUserId: nurseUser });
    // Three active medicine lines (Augmentin ×3 written above, Paracetamol) + two home medicines continued or held.
    const card = await admin`select count(*)::int as n from treatment_orders where admission_id = ${admissionId} and kind = 'medicine' and stopped_at is null and voided_at is null`;
    expect(added).toBe(card[0].n + 2);
    expect((await prepareDischargeList({ hospitalId, admissionId, actorUserId: nurseUser })).added).toBe(0);
    const view = await getMedRec(hospitalId, admissionId);
    expect(view.cardLinesNotListed).toEqual([]);
    for (const item of view.discharge.items) {
      await decideMedRecItem({
        hospitalId,
        itemId: item.id,
        decision: item.name.startsWith('Paracetamol') ? 'stop' : 'continue',
        note: item.name.startsWith('Paracetamol') ? 'Afebrile' : null,
        actorUserId: doctorUser,
      });
    }
    await addMedRecItem({ hospitalId, admissionId, phase: 'discharge', input: parseMedRecItem({ name: 'Tab Pantoprazole 40 mg', dose: '1', frequency: 'OD before breakfast', duration: '14 days' }), source: 'new', clientId: uuid(), actorUserId: doctorUser });
    await signMedRec({ hospitalId, admissionId, phase: 'discharge', noneAtHome: false, actorUserId: doctorUser });
    const after = await getMedRec(hospitalId, admissionId);
    expect(after.discharge.signoff).not.toBeNull();
    expect(after.discharge.goingHome.map((i) => i.name)).toContain('Tab Pantoprazole 40 mg');
    expect(after.discharge.goingHome.some((i) => i.name.startsWith('Paracetamol'))).toBe(false);
    expect(after.discharge.goingHome.find((i) => i.name === 'Tab Metformin 500 mg')?.source).toBe('home');
  });

  it('alerts the desk when charges use 80% of the deposit', async () => {
    const settings = depositAlertSettingsFrom(null);
    expect((await listDepositAlerts({ hospitalId, settings })).map((a) => a.admissionId)).not.toContain(admissionId);
    const cef = await order(ceftriaxone);
    await recordGive({ hospitalId, orderId: cef.orderId, occurredAt: new Date(), dose: null, quantity: 1, lateReason: null, witnessUserId: null, clientId: uuid(), actor: doctor, stage: 'observe' });
    const alerts = await listDepositAlerts({ hospitalId, settings });
    const mine = alerts.find((a) => a.admissionId === admissionId);
    expect(mine).toMatchObject({ reason: 'used', patientName: 'Shobha Patil', paidPaise: 10_000 });
    expect(mine!.usedPct).toBeGreaterThanOrEqual(90);
    expect((await listDepositAlerts({ hospitalId, settings: { usedPct: 100, balancePaise: 500_000 } })).some((a) => a.admissionId === admissionId)).toBe(false);
  });

  it('holds allergies and reconciliation in the database', async () => {
    const [a] = await admin`select id from patient_allergies where hospital_id = ${hospitalId} and voided_at is null limit 1`;
    await expect(admin`update patient_allergies set severity = 'mild' where id = ${a.id}`).rejects.toThrow(/cannot be edited/);
    await expect(admin`delete from patient_allergies where id = ${a.id}`).rejects.toThrow(/never deleted/);
    const [item] = await admin`select id from med_rec_items where hospital_id = ${hospitalId} limit 1`;
    await expect(admin`update med_rec_items set name = 'Other' where id = ${item.id}`).rejects.toThrow(/cannot be edited/);
    await expect(admin`update med_rec_signoffs set items = 9 where hospital_id = ${hospitalId}`).rejects.toThrow();
    await expect(
      admin`update treatment_orders set allergy_matches = array['x'] where id = (select id from treatment_orders where hospital_id = ${hospitalId} and allergy_matches is null limit 1)`,
    ).rejects.toThrow();
    const [evidence] = await admin`select count(*)::int as n from acct_events where hospital_id = ${hospitalId} and object_type in ('patient_allergy', 'allergy_review', 'med_rec_item', 'med_rec_signoff')`;
    expect(evidence.n).toBeGreaterThan(8);
  });
});
