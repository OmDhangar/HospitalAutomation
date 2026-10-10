import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { marAdministrations, treatmentOrders } from '@/lib/db/schema';
import { parseOrder } from '@/lib/domain/mar';
import { hashPassword } from '@/lib/security/password';
import { createDirectAdmission } from '@/lib/services/admissions';
import { createWard } from '@/lib/services/ipd-config';
import {
  MarError,
  askWitnessAgain,
  countersignOrder,
  createOrder,
  decideWitnessRequest,
  getTreatmentCard,
  listBedCodes,
  listDeviceWitnessRequests,
  listMyWitnessRequests,
  proveAtBed,
  recordGive,
  recordNotGiven,
  stopOrder,
  strikeOutDose,
  strikeOutOrder,
  sweepWitnesses,
  witnessOnDevice,
  type Actor,
} from '@/lib/services/mar';
import { createRiskClass, setMedicineRiskClass } from '@/lib/services/stock';
import { createWardDevice, enrolWardDevice, resolveWardDevice, setOwnPin, type WardDevice } from '@/lib/services/staff-access';
import { chartDayOf } from '@/lib/domain/tpr';

/**
 * The treatment card and MAR against a real database (IPD sheets plan B3-min,
 * migration 0048): signed and transcribed lines and the countersign; doses
 * given (billed through a bedside entry, once per retry) and not given; the
 * risk-class controls in observe and enforce (countersign, bedside code,
 * witness); witnessing on the ward tablet with a PIN and by approval from the
 * witness's own session; the sweep; and the database guards.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'MAR Test Hospital';
const TZ = 'Asia/Kolkata';
const PASSWORD = 'correct horse battery';

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

describe.skipIf(!enabled)('treatment card and MAR (0048)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const app = enabled ? postgres(appUrl!, { max: 1 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const [ownerUser, doctorUser, nurseA, nurseB, deskUser] = [uuid(), uuid(), uuid(), uuid(), uuid()];
  const [morphine, ceftriaxone, midazolam] = [uuid(), uuid(), uuid()];
  let admissionId = '';
  let wardId = '';
  let device: WardDevice;

  const personal = (userId: string): Actor => ({ userId, channel: 'personal', wardDeviceId: null });
  const tablet = (userId: string): Actor => ({ userId, channel: 'ward_device', wardDeviceId: device.id });

  const order = (medicineId: string, actor: Actor, opts: { route?: string; mayTranscribe?: boolean } = {}) =>
    createOrder({
      hospitalId,
      admissionId,
      input: parseOrder({ kind: 'medicine', medicineId, dose: '1 amp', route: opts.route ?? 'iv', frequency: 'BD' }),
      orderingDoctorId: doctorId,
      clientId: uuid(),
      actor,
      mayTranscribe: opts.mayTranscribe ?? true,
    });

  const give = (orderId: string, actor: Actor, extra: Partial<Parameters<typeof recordGive>[0]> = {}) =>
    recordGive({
      hospitalId,
      orderId,
      occurredAt: new Date(),
      dose: null,
      quantity: 1,
      lateReason: null,
      witnessUserId: null,
      clientId: uuid(),
      actor,
      stage: 'observe',
      ...extra,
    });

  const dose = async (marId: string) => (await admin`select * from mar_administrations where id = ${marId}`)[0] as Record<string, unknown>;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'mar-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    const hash = await hashPassword(PASSWORD);
    await admin`insert into users (id, email, password_hash, name, last_login_at) values
      (${ownerUser}, ${'o-' + ownerUser + '@mar.test'}, ${hash}, 'Owner', now()),
      (${doctorUser}, ${'d-' + doctorUser + '@mar.test'}, ${hash}, 'Dr Pawara', now()),
      (${nurseA}, ${'a-' + nurseA + '@mar.test'}, ${hash}, 'Sister Anita', now()),
      (${nurseB}, ${'b-' + nurseB + '@mar.test'}, ${hash}, 'Sister Meena', now()),
      (${deskUser}, ${'r-' + deskUser + '@mar.test'}, ${hash}, 'Desk Mane', now())`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerUser}, ${hospitalId}, 'owner'), (${doctorUser}, ${hospitalId}, 'doctor'),
      (${nurseA}, ${hospitalId}, 'nurse'), (${nurseB}, ${hospitalId}, 'nurse'), (${deskUser}, ${hospitalId}, 'receptionist')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Pawara', ${doctorUser}, 10)`;
    await admin`insert into medicines (id, hospital_id, name, strength, form, unit, selling_price_paise) values
      (${morphine}, ${hospitalId}, 'Morphine', '10 mg/ml', 'injection', 'ampoule', 5000),
      (${ceftriaxone}, ${hospitalId}, 'Ceftriaxone', '1 g', 'injection', 'vial', 9000),
      (${midazolam}, ${hospitalId}, 'Midazolam', '5 mg/ml', 'injection', 'ampoule', 3000)`;
    const ndps = await createRiskClass({ hospitalId, name: 'NDPS', kind: 'ndps', countEvery: 'daily', actorUserId: ownerUser });
    const psycho = await createRiskClass({ hospitalId, name: 'Psychotropics', kind: 'psychotropic', countEvery: 'daily', actorUserId: ownerUser });
    await setMedicineRiskClass({ hospitalId, medicineId: morphine, riskClassId: ndps, actorUserId: ownerUser });
    await setMedicineRiskClass({ hospitalId, medicineId: midazolam, riskClassId: psycho, actorUserId: ownerUser });

    ({ wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerUser }));
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919300000077', name: 'Ramesh Pawar' },
      bedId: bed.id as string,
      actorUserId: ownerUser,
    }));

    const created = await createWardDevice({ hospitalId, branchId, name: 'Ward A tablet', wardIds: [], actorUserId: ownerUser });
    device = (await resolveWardDevice((await enrolWardDevice(created.code))!.cookieValue))!;
    await setOwnPin({ hospitalId, userId: nurseB, pin: '4826', password: PASSWORD });
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['witness_requests', 'presence_proofs', 'mar_administrations', 'treatment_orders', 'stock_ledger', 'medicine_risk_classes', 'risk_classes']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@mar.test'`;
    await Promise.all([admin.end(), app.end(), closeDb()]);
  });

  it('signs a line written by the doctor, and holds a transcribed one for that doctor’s countersign', async () => {
    const signed = await order(ceftriaxone, personal(doctorUser));
    expect(signed.transcribed).toBe(false);
    const phoned = await order(ceftriaxone, personal(nurseA));
    expect(phoned.transcribed).toBe(true);
    await expect(order(ceftriaxone, personal(deskUser), { mayTranscribe: false })).rejects.toThrow(/named doctor/);

    await expect(countersignOrder({ hospitalId, orderId: phoned.orderId, actorUserId: ownerUser })).rejects.toThrow(/Only the doctor named/);
    await countersignOrder({ hospitalId, orderId: phoned.orderId, actorUserId: doctorUser });
    await countersignOrder({ hospitalId, orderId: phoned.orderId, actorUserId: doctorUser }); // twice: no change
    await expect(countersignOrder({ hospitalId, orderId: signed.orderId, actorUserId: doctorUser })).rejects.toThrow(/needs no countersign/);
  });

  it('gives a dose once however often it is retried, billing it through a bedside entry', async () => {
    const { orderId } = await order(ceftriaxone, personal(doctorUser));
    const clientId = uuid();
    const first = await give(orderId, personal(nurseA), { clientId, quantity: 2 });
    const again = await give(orderId, personal(nurseA), { clientId, quantity: 2 });
    expect(again).toMatchObject({ marId: first.marId, repeat: true });
    const row = await dose(first.marId);
    expect(row).toMatchObject({ state: 'given', quantity: 2, witness_status: 'not_needed', dose: '1 amp' });
    const lines = await admin`select b.total_paise, b.quantity from bill_items b join care_entries c on c.id = b.care_entry_id where c.id = ${row.care_entry_id as string}`;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ total_paise: 18000, quantity: 2 });

    // Not given needs its reason; "other" in words.
    await expect(recordNotGiven({ hospitalId, orderId, occurredAt: new Date(), choice: 'other', reasonText: null, clientId: uuid(), actor: personal(nurseA) })).rejects.toThrow(/why/);
    const refused = await recordNotGiven({ hospitalId, orderId, occurredAt: new Date(), choice: 'refused', reasonText: null, clientId: uuid(), actor: personal(nurseA) });
    expect(await dose(refused.marId)).toMatchObject({ state: 'refused', reason_code: 'refused', quantity: null, care_entry_id: null });
  });

  it('refuses a stopped line, a future time, and a give over 48 hours late; asks why for one over 2 hours late', async () => {
    const { orderId } = await order(ceftriaxone, personal(doctorUser));
    await expect(give(orderId, personal(nurseA), { occurredAt: new Date(Date.now() + 30 * 60_000) })).rejects.toThrow(/future/);
    await expect(give(orderId, personal(nurseA), { occurredAt: new Date(Date.now() - 50 * 3_600_000) })).rejects.toThrow(/48 hours/);
    await expect(give(orderId, personal(nurseA), { occurredAt: new Date(Date.now() - 3 * 3_600_000) })).rejects.toThrow(/written late/);
    const late = await give(orderId, personal(nurseA), { occurredAt: new Date(Date.now() - 3 * 3_600_000), lateReason: 'Busy with an emergency' });
    expect(late.flags).toEqual(['late_entry']);
    await stopOrder({ hospitalId, orderId, actorUserId: doctorUser, reason: 'Course complete' });
    await expect(give(orderId, personal(nurseA))).rejects.toThrow(/stopped/);
  });

  it('in observe, records a risk-class give with what was missing; in enforce, refuses it', async () => {
    const phoned = await order(morphine, personal(nurseA));
    // From a personal phone, no countersign, no bed code, no witness: saved, with three flags.
    const flagged = await give(phoned.orderId, personal(nurseA));
    expect(flagged.witness).toBe('skipped');
    expect(flagged.flags.sort()).toEqual(['no_presence', 'no_witness', 'uncountersigned_order']);
    expect(await dose(flagged.marId)).toMatchObject({ witness_status: 'skipped' });

    const enforce = { stage: 'enforce' as const };
    await expect(give(phoned.orderId, personal(nurseA), enforce)).rejects.toThrow(/countersign/);
    await countersignOrder({ hospitalId, orderId: phoned.orderId, actorUserId: doctorUser });
    await expect(give(phoned.orderId, personal(nurseA), enforce)).rejects.toThrow(/code on the patient’s bed/);

    const [code] = await listBedCodes(hospitalId, wardId);
    expect(code.code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    await expect(proveAtBed({ hospitalId, admissionId, code: 'ZZZZZZ', actor: personal(nurseA) })).rejects.toThrow(/not the code/);
    await proveAtBed({ hospitalId, admissionId, code: `${code.code!.slice(0, 3).toLowerCase()}-${code.code!.slice(3)}`, actor: personal(nurseA) });
    await expect(give(phoned.orderId, personal(nurseA), enforce)).rejects.toThrow(/Choose who will witness/);
    await expect(give(phoned.orderId, personal(nurseA), { ...enforce, witnessUserId: nurseA })).rejects.toThrow(/someone else/);
    await expect(give(phoned.orderId, personal(nurseA), { ...enforce, witnessUserId: deskUser })).rejects.toThrow(/doctor or nurse/);

    const ok = await give(phoned.orderId, personal(nurseA), { ...enforce, witnessUserId: nurseB });
    expect(ok).toMatchObject({ witness: 'approval', flags: [] });
    expect(await dose(ok.marId)).toMatchObject({ witness_status: 'awaiting' });

    // The witness approves from their own session.
    const mine = await listMyWitnessRequests({ hospitalId, userId: nurseB });
    const request = mine.find((r) => r.actorUserId === nurseA)!;
    expect(request).toMatchObject({ patientName: 'Ramesh Pawar', bed: 'Ward A · Bed 1' });
    await expect(decideWitnessRequest({ hospitalId, requestId: request.id, userId: doctorUser, approve: true, channel: 'personal', deviceId: null, sessionId: null })).rejects.toThrow(/not found/);
    await decideWitnessRequest({ hospitalId, requestId: request.id, userId: nurseB, approve: true, channel: 'personal', deviceId: null, sessionId: null });
    expect(await dose(ok.marId)).toMatchObject({ witness_status: 'witnessed', witnessed_by_user_id: nurseB });
  });

  it('needs a witness for an IV psychotropic but not an oral one, and takes it on the ward tablet with a PIN', async () => {
    const oral = await order(midazolam, personal(doctorUser), { route: 'oral' });
    const oralGive = await give(oral.orderId, tablet(nurseA));
    expect(oralGive.witness).toBe('not_needed');

    const iv = await order(midazolam, personal(doctorUser), { route: 'iv' });
    const ivGive = await give(iv.orderId, tablet(nurseA), { stage: 'enforce' });
    // On the tablet: no bed code needed, the witness takes the tablet.
    expect(ivGive).toMatchObject({ witness: 'ward_device', flags: [] });
    const waiting = await listDeviceWitnessRequests({ hospitalId, deviceId: device.id });
    const request = waiting.find((r) => r.description.startsWith('Midazolam'))!;

    await expect(witnessOnDevice({ hospitalId, requestId: request.id, device, witnessUserId: nurseB, pin: '0000', sessionId: null })).rejects.toThrow(/Wrong PIN/);
    await expect(witnessOnDevice({ hospitalId, requestId: request.id, device, witnessUserId: nurseA, pin: '4826', sessionId: null })).rejects.toThrow(MarError);
    await witnessOnDevice({ hospitalId, requestId: request.id, device, witnessUserId: nurseB, pin: '4826', sessionId: null });
    expect(await dose(ivGive.marId)).toMatchObject({ witness_status: 'witnessed', witnessed_by_user_id: nurseB });
  });

  it('closes unanswered requests, flags a give still unwitnessed after 15 minutes, and lets the nurse ask again', async () => {
    const { orderId } = await order(morphine, personal(doctorUser));
    const g = await give(orderId, tablet(nurseA));
    expect(g.witness).toBe('ward_device');
    await sweepWitnesses(new Date(Date.now() + 16 * 60_000));
    const row = await dose(g.marId);
    expect(row.control_flags).toContain('witness_late');
    expect((await listDeviceWitnessRequests({ hospitalId, deviceId: device.id })).some((r) => r.description.startsWith('Morphine') && r.actorUserId === nurseA && r.occurredAt.getTime() === g.occurredAt.getTime())).toBe(false);

    await expect(askWitnessAgain({ hospitalId, marId: g.marId, witnessUserId: null, actor: tablet(nurseB) })).rejects.toThrow(/Only whoever gave/);
    await askWitnessAgain({ hospitalId, marId: g.marId, witnessUserId: doctorUser, actor: personal(nurseA) });
    const [request] = await listMyWitnessRequests({ hospitalId, userId: doctorUser });
    await decideWitnessRequest({ hospitalId, requestId: request.id, userId: doctorUser, approve: true, channel: 'personal', deviceId: null, sessionId: null });
    // Witnessed late: the flag stays.
    expect(await dose(g.marId)).toMatchObject({ witness_status: 'witnessed' });
    expect((await dose(g.marId)).control_flags).toContain('witness_late');
  });

  it('strikes out a dose with its bill line, and a line only while it has no doses', async () => {
    const { orderId } = await order(ceftriaxone, personal(doctorUser));
    const g = await give(orderId, personal(nurseA));
    await expect(strikeOutOrder({ hospitalId, orderId, actorUserId: doctorUser, isOwner: false, reason: '' })).rejects.toThrow(/Stop it instead/);
    await expect(strikeOutDose({ hospitalId, marId: g.marId, actorUserId: nurseB, isOwner: false, reason: 'Wrong patient' })).rejects.toThrow(/Only whoever recorded/);
    await strikeOutDose({ hospitalId, marId: g.marId, actorUserId: nurseA, isOwner: false, reason: 'Wrong patient' });
    const row = await dose(g.marId);
    expect(row.voided_at).not.toBeNull();
    const line = await admin`select voided_at from bill_items where care_entry_id = ${row.care_entry_id as string}`;
    expect(line[0].voided_at).not.toBeNull();
    await strikeOutOrder({ hospitalId, orderId, actorUserId: doctorUser, isOwner: false, reason: 'Wrong drug' });
    expect((await admin`select void_reason from treatment_orders where id = ${orderId}`)[0].void_reason).toBe('Wrong drug');
  });

  it('shows the card and the day’s doses, with witnesses and flags', async () => {
    const card = await getTreatmentCard({ hospitalId, admissionId, day: chartDayOf(new Date(), TZ), timezone: TZ });
    const morphineLine = card.orders.find((o) => o.description.startsWith('Morphine') && o.transcribed)!;
    expect(morphineLine).toMatchObject({ status: 'active', risk: { className: 'NDPS', needsWitness: true } });
    expect(card.orders.at(-1)?.status).toBe('struck_out');
    const witnessed = card.doses.filter((d) => d.witnessStatus === 'witnessed');
    expect(witnessed.length).toBeGreaterThanOrEqual(3);
    expect(witnessed.every((d) => d.witnessedBy)).toBe(true);
    expect(card.doses.some((d) => d.flags.includes('no_witness'))).toBe(true);
  });

  it('keeps the card one-way and behind the clinical key', async () => {
    const asApp = (q: string, clinicalKey = true) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.hospital_id', ${hospitalId}, true), set_config('app.clinical_access', ${clinicalKey ? 'true' : 'false'}, true)`;
        return tx.unsafe(q);
      });
    const [line] = await admin`select id from treatment_orders where hospital_id = ${hospitalId} and voided_at is null limit 1`;
    const [given] = await admin`select id from mar_administrations where hospital_id = ${hospitalId} and state = 'given' and witnessed_by_user_id is not null limit 1`;
    await rejectsWith(asApp(`update treatment_orders set dose = '2 amp' where id = '${line.id}'`), /cannot be edited/);
    await rejectsWith(asApp(`delete from treatment_orders where id = '${line.id}'`), /permission denied|cannot be deleted/);
    await rejectsWith(asApp(`update mar_administrations set quantity = 5 where id = '${given.id}'`), /cannot be edited/);
    await rejectsWith(asApp(`update mar_administrations set witness_status = 'awaiting', witnessed_at = null, witnessed_by_user_id = null where id = '${given.id}'`), /cannot be taken back|already witnessed/);
    const [flagged] = await admin`select id from mar_administrations where hospital_id = ${hospitalId} and cardinality(control_flags) > 0 limit 1`;
    await rejectsWith(asApp(`update mar_administrations set control_flags = '{}' where id = '${flagged.id}'`), /cannot be removed/);
    await rejectsWith(asApp(`update witness_requests set status = 'pending', decided_at = null where hospital_id = '${hospitalId}' and status = 'approved'`), /decided once/);
    const hidden = await asApp(`select id from mar_administrations`, false);
    expect(hidden).toHaveLength(0);
    const plain = await withTenant(hospitalId, (tx) => tx.select({ id: treatmentOrders.id }).from(treatmentOrders));
    expect(plain).toEqual([]);
    const seen = await withTenant(hospitalId, (tx) => tx.select({ id: marAdministrations.id }).from(marAdministrations), { clinical: true });
    expect(seen.length).toBeGreaterThan(5);
  });

  it('puts every step in the evidence log', async () => {
    const events = await admin`select action, count(*)::int as n from acct_events where hospital_id = ${hospitalId}
      and (action like 'treatment_order%' or action like 'mar_%' or action like 'witness_%' or action like 'presence_%') group by action`;
    const by = Object.fromEntries(events.map((e) => [e.action, e.n]));
    expect(by['treatment_order.created']).toBeGreaterThanOrEqual(8);
    expect(by['treatment_order.changed']).toBeGreaterThanOrEqual(3);
    expect(by['treatment_order.voided']).toBe(1);
    expect(by['mar_administration.created']).toBeGreaterThanOrEqual(8);
    expect(by['mar_administration.voided']).toBe(1);
    expect(by['witness_request.created']).toBeGreaterThanOrEqual(3);
    expect(by['witness_request.changed']).toBeGreaterThanOrEqual(3);
    expect(by['presence_proof.created']).toBe(1);
  });
});
