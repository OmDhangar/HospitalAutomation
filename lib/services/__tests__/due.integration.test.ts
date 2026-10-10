import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { boardInstances } from '@/lib/domain/due';
import { parseOrder } from '@/lib/domain/mar';
import { createDirectAdmission } from '@/lib/services/admissions';
import {
  acknowledgeEscalation,
  addOnCall,
  computeDueRollups,
  getDueQuality,
  getMarConfig,
  getWardBoard,
  myEscalations,
  rateAlerts,
  setTimeCritical,
  setWardInCharge,
  signOffTimeCritical,
  snoozeDue,
  sweepDueEscalations,
  updateDueSettings,
  wardBadges,
} from '@/lib/services/due';
import { createWard } from '@/lib/services/ipd-config';
import { createOrder, recordGive, recordNotGiven, recordTaskDone, type Actor, type DueContext } from '@/lib/services/mar';

/**
 * Due times and time-critical alerts against a real database (IPD sheets plan
 * B3b, migration 0049): timing stored on lines, doses recorded against their
 * due time (on time, late with a reason in enforce, never twice), tasks done
 * by a chart reading, snoozes, the sign-off that switches alerts on, the
 * escalation sweep in observe, warn and enforce, acknowledgement, the ward's
 * badges, and the hourly roll-ups.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Due Test Hospital';
const TZ = 'Asia/Kolkata';
const HOUR = 3_600_000;

describe.skipIf(!enabled)('due times and alerts (0049)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const [doctorId, onCallDoctorId] = [uuid(), uuid()];
  const [ownerUser, doctorUser, onCallUser, nurse, inCharge] = [uuid(), uuid(), uuid(), uuid(), uuid()];
  const [enoxaparin, paracetamol] = [uuid(), uuid()];
  let admissionId = '';
  let wardId = '';
  const now = new Date();
  const actor: Actor = { userId: nurse, channel: 'personal', wardDeviceId: null };

  const line = (medicineId: string, timing: Record<string, string>, orderedAt: Date) =>
    createOrder({
      hospitalId,
      admissionId,
      input: parseOrder({ kind: 'medicine', medicineId, dose: '40 mg', route: 'sc', frequency: 'q12h', ...timing }, orderedAt),
      orderingDoctorId: doctorId,
      clientId: uuid(),
      actor: { userId: doctorUser, channel: 'personal', wardDeviceId: null },
      mayTranscribe: false,
      now: orderedAt,
    });

  const due = async (dueAt: Date | null, reason: string | null = null, enforce = false): Promise<DueContext> => {
    const config = await getMarConfig(hospitalId);
    return { dueAt, reason, settings: config.settings, tcActive: config.tcActive, timezone: TZ, enforce };
  };

  const setStage = (stage: string) => admin`update hospital_features set stage = ${stage} where hospital_id = ${hospitalId} and module_id = 'mar'`;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'due-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into users (id, email, password_hash, name) values
      (${ownerUser}, ${'o-' + ownerUser + '@due.test'}, 'x', 'Owner'),
      (${doctorUser}, ${'d-' + doctorUser + '@due.test'}, 'x', 'Dr Pawara'),
      (${onCallUser}, ${'c-' + onCallUser + '@due.test'}, 'x', 'Dr On Call'),
      (${nurse}, ${'n-' + nurse + '@due.test'}, 'x', 'Sister Anita'),
      (${inCharge}, ${'i-' + inCharge + '@due.test'}, 'x', 'Sister In-charge')`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerUser}, ${hospitalId}, 'owner'), (${doctorUser}, ${hospitalId}, 'doctor'), (${onCallUser}, ${hospitalId}, 'doctor'),
      (${nurse}, ${hospitalId}, 'nurse'), (${inCharge}, ${hospitalId}, 'nurse')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes) values
      (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Pawara', ${doctorUser}, 10),
      (${onCallDoctorId}, ${hospitalId}, ${branchId}, 'Dr On Call', ${onCallUser}, 10)`;
    await admin`insert into medicines (id, hospital_id, name, strength, form, unit, selling_price_paise) values
      (${enoxaparin}, ${hospitalId}, 'Enoxaparin', '40 mg', 'injection', 'syringe', 30000),
      (${paracetamol}, ${hospitalId}, 'Paracetamol', '500 mg', 'tablet', 'tablet', 200)`;
    await admin`insert into hospital_features (hospital_id, module_id, state, stage) values (${hospitalId}, 'mar', 'on', 'observe')`;
    ({ wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerUser }));
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919300000055', name: 'Kamal Patil' },
      bedId: bed.id as string,
      actorUserId: ownerUser,
    }));
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['due_escalations', 'due_snoozes', 'due_rollups_daily', 'alert_ratings', 'on_call_assignments', 'time_critical_signoffs', 'witness_requests', 'mar_administrations', 'treatment_orders', 'chart_entries']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@due.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('stores timing on a line, suggested from the frequency or as the doctor chose', async () => {
    const { orderId } = await line(paracetamol, { frequency: 'BD' }, now);
    const [row] = await admin`select timing_mode, clock_times, late_policy from treatment_orders where id = ${orderId}`;
    expect(row).toMatchObject({ timing_mode: 'clock', clock_times: [480, 1200], late_policy: 'keep' });
    const interval = await line(paracetamol, { timingMode: 'interval', intervalHours: '6', firstDueAt: now.toISOString() }, now);
    const [r2] = await admin`select timing_mode, interval_min, late_policy from treatment_orders where id = ${interval.orderId}`;
    expect(r2).toMatchObject({ timing_mode: 'interval', interval_min: 360, late_policy: 'shift' });
  });

  it('switches time-critical alerts on only while the doctor’s sign-off matches the list and windows', async () => {
    await setTimeCritical({ hospitalId, medicineId: enoxaparin, timeCritical: true, before: null, after: null, actorUserId: doctorUser });
    expect((await getMarConfig(hospitalId)).tcActive).toBe(false);
    await expect(signOffTimeCritical({ hospitalId, actorUserId: nurse, note: null })).rejects.toThrow(/Only a doctor/);
    await signOffTimeCritical({ hospitalId, actorUserId: doctorUser, note: 'Reviewed with the pharmacist' });
    expect((await getMarConfig(hospitalId)).tcActive).toBe(true);
    // A new window needs a new sign-off.
    await updateDueSettings({ hospitalId, settings: { tcWindowMin: 20 }, actorUserId: ownerUser });
    expect((await getMarConfig(hospitalId)).tcActive).toBe(false);
    await updateDueSettings({ hospitalId, settings: { tcWindowMin: 30 }, actorUserId: ownerUser });
    expect((await getMarConfig(hospitalId)).tcActive).toBe(true);
    await expect(updateDueSettings({ hospitalId, settings: { l1AfterMin: 60, l2AfterMin: 30 }, actorUserId: ownerUser })).rejects.toThrow(/Level 2/);
  });

  it('records a dose against its due time: late with its delay, refused without a reason in enforce, never twice', async () => {
    const firstDue = new Date(now.getTime() - 90 * 60_000);
    const { orderId } = await line(enoxaparin, { timingMode: 'interval', intervalHours: '12', firstDueAt: firstDue.toISOString(), latePolicy: 'keep' }, new Date(firstDue.getTime() - HOUR));
    const given = new Date(firstDue.getTime() + 50 * 60_000);
    const base = { hospitalId, orderId, occurredAt: given, dose: null, quantity: 1, lateReason: null, witnessUserId: null, actor, stage: 'observe' as const };
    await expect(recordGive({ ...base, clientId: uuid(), due: await due(firstDue, null, true) })).rejects.toThrow(/after its window/);
    const ok = await recordGive({ ...base, clientId: uuid(), due: await due(firstDue, 'Patient in X-ray') });
    const [row] = await admin`select due_at, timing_status, delay_min, timing_reason from mar_administrations where id = ${ok.marId}`;
    expect(row).toMatchObject({ timing_status: 'late', delay_min: 50, timing_reason: 'Patient in X-ray' });
    await expect(recordGive({ ...base, clientId: uuid(), due: await due(firstDue) })).rejects.toThrow(/already recorded/);
    await expect(recordGive({ ...base, clientId: uuid(), due: await due(new Date(firstDue.getTime() + 60_000)) })).rejects.toThrow(/not one of this line’s due times/);
  });

  it('marks a vitals task done by a chart reading in its window, or by a tick', async () => {
    const first = new Date(now.getTime() - 2 * HOUR);
    const task = await createOrder({
      hospitalId,
      admissionId,
      input: parseOrder({ kind: 'task', taskKind: 'vitals', description: 'TPR and BP', timingMode: 'interval', intervalHours: '4', firstDueAt: first.toISOString() }, first),
      orderingDoctorId: doctorId,
      clientId: uuid(),
      actor: { userId: doctorUser, channel: 'personal', wardDeviceId: null },
      mayTranscribe: false,
      now: new Date(first.getTime() - HOUR),
    });
    const [adm] = await admin`select encounter_id, patient_id from admissions where id = ${admissionId}`;
    await admin`insert into chart_entries (hospital_id, branch_id, admission_id, encounter_id, patient_id, observed_at, pulse, recorded_by_user_id, client_id)
      values (${hospitalId}, ${branchId}, ${admissionId}, ${adm.encounter_id}, ${adm.patient_id}, ${new Date(first.getTime() + 20 * 60_000)}, 88, ${nurse}, ${uuid()})`;
    const board = await getWardBoard({ hospitalId, wardId, userId: nurse, timezone: TZ, now });
    const items = boardInstances(board, now).filter((i) => i.line.orderId === task.orderId);
    expect(items[0].instance.status).toBe('given_on_time');
    expect(items[0].instance.record?.fromChart).toBe(true);
    const next = items[1].instance.dueAt;
    await recordTaskDone({ hospitalId, orderId: task.orderId, occurredAt: now, note: null, clientId: uuid(), actor, due: await due(next) });
    await expect(recordNotGiven({ hospitalId, orderId: task.orderId, occurredAt: now, choice: 'refused', reasonText: null, clientId: uuid(), actor, due: await due(next) })).rejects.toThrow(/already recorded/);
  });

  it('snoozes a time-critical alert twice at most, with a reason, never past 30 minutes', async () => {
    const firstDue = new Date(now.getTime() - 2 * HOUR);
    const { orderId } = await line(enoxaparin, { timingMode: 'interval', intervalHours: '24', firstDueAt: firstDue.toISOString() }, new Date(firstDue.getTime() - HOUR));
    await expect(snoozeDue({ hospitalId, orderId, dueAt: firstDue, minutes: 45, reason: 'At CT', actorUserId: nurse })).rejects.toThrow(/5 to 30/);
    await expect(snoozeDue({ hospitalId, orderId, dueAt: firstDue, minutes: 20, reason: '', actorUserId: nurse })).rejects.toThrow(/why/);
    await snoozeDue({ hospitalId, orderId, dueAt: firstDue, minutes: 20, reason: 'At CT scan', actorUserId: nurse });
    await snoozeDue({ hospitalId, orderId, dueAt: firstDue, minutes: 20, reason: 'Still at CT', actorUserId: nurse });
    await expect(snoozeDue({ hospitalId, orderId, dueAt: firstDue, minutes: 20, reason: 'Again', actorUserId: nurse })).rejects.toThrow(/twice/);
    const board = await getWardBoard({ hospitalId, wardId, userId: nurse, timezone: TZ, now });
    const item = boardInstances(board, now).find((i) => i.line.orderId === orderId)!;
    expect(item.instance).toMatchObject({ status: 'overdue', escalation: 0 });
    expect(item.instance.snoozedUntil).not.toBeNull();
  });

  it('escalates an overdue time-critical dose: counted in observe, L1 live in warn, L2 to the doctor on call in enforce', async () => {
    const firstDue = new Date(now.getTime() - 3 * HOUR);
    const { orderId } = await line(enoxaparin, { timingMode: 'interval', intervalHours: '24', firstDueAt: firstDue.toISOString() }, new Date(firstDue.getTime() - HOUR));
    const rows = () => admin`select level, mode, target, target_user_id from due_escalations where order_id = ${orderId} order by level`;

    await setStage('observe');
    await sweepDueEscalations(now);
    expect((await rows()).map((r) => `${r.level}:${r.mode}`)).toEqual(['1:observe', '2:observe']);

    // Another overdue dose under warn: L1 live to the ward in-charge.
    await setWardInCharge({ hospitalId, wardId, userId: inCharge, actorUserId: ownerUser });
    await setStage('warn');
    const second = await line(enoxaparin, { timingMode: 'interval', intervalHours: '24', firstDueAt: firstDue.toISOString() }, new Date(firstDue.getTime() - HOUR));
    await sweepDueEscalations(now);
    const warned = await admin`select level, mode, target, target_user_id from due_escalations where order_id = ${second.orderId} order by level`;
    expect(warned.map((r) => `${r.level}:${r.mode}:${r.target}`)).toEqual(['1:live:ward_in_charge', '2:observe:on_call'.replace('on_call', 'ordering_doctor')]);
    expect(warned[0].target_user_id).toBe(inCharge);

    await setStage('enforce');
    await addOnCall({ hospitalId, branchId, doctorId: onCallDoctorId, startsAt: new Date(now.getTime() - HOUR), endsAt: new Date(now.getTime() + 11 * HOUR), actorUserId: ownerUser });
    const third = await line(enoxaparin, { timingMode: 'interval', intervalHours: '24', firstDueAt: firstDue.toISOString() }, new Date(firstDue.getTime() - HOUR));
    await sweepDueEscalations(now);
    await sweepDueEscalations(now); // twice: nothing new
    const enforced = await admin`select level, mode, target, target_user_id from due_escalations where order_id = ${third.orderId} order by level`;
    expect(enforced.map((r) => `${r.level}:${r.mode}:${r.target}`)).toEqual(['1:live:ward_in_charge', '2:live:on_call']);
    expect(enforced[1].target_user_id).toBe(onCallUser);

    // Banners: no patient or drug, by ward and level.
    expect(await myEscalations({ hospitalId, userId: onCallUser, isOwner: false, wardIds: null })).toEqual([{ wardId, wardName: 'Ward A', level: 2, count: 1 }]);
    const forInCharge = await myEscalations({ hospitalId, userId: inCharge, isOwner: false, wardIds: null });
    expect(forInCharge.find((e) => e.level === 1)?.count).toBeGreaterThanOrEqual(2);

    const [l2] = await admin`select id from due_escalations where order_id = ${third.orderId} and level = 2`;
    await acknowledgeEscalation({ hospitalId, escalationId: l2.id, actorUserId: onCallUser });
    await expect(acknowledgeEscalation({ hospitalId, escalationId: l2.id, actorUserId: onCallUser })).rejects.toThrow(/Already/);
    expect(await myEscalations({ hospitalId, userId: onCallUser, isOwner: false, wardIds: null })).toEqual([]);
    await expect(admin`delete from due_escalations where id = ${l2.id}`).rejects.toThrow(/cannot be deleted/);
  });

  it('badges the bed and asks once per shift about alert volume', async () => {
    const badges = await wardBadges({ hospitalId, wardId, userId: nurse, timezone: TZ, now });
    expect(badges.get(admissionId)).toMatchObject({ escalated: true });
    expect(badges.get(admissionId)!.overdue).toBeGreaterThan(0);
    await rateAlerts({ hospitalId, wardId, userId: nurse, rating: 'about_right', timezone: TZ, now });
    await rateAlerts({ hospitalId, wardId, userId: nurse, rating: 'too_many', timezone: TZ, now });
    const board = await getWardBoard({ hospitalId, wardId, userId: nurse, timezone: TZ, now });
    expect(board.ratedThisShift).toBe(true);
  });

  it('rolls up the day per ward into on-time figures', async () => {
    expect(await computeDueRollups(new Date(), { hospitalId })).toBeGreaterThan(0);
    const quality = await getDueQuality(hospitalId, 14, new Date());
    const tc = quality.rollups.find((r) => r.timeCritical);
    expect(tc).toBeTruthy();
    expect(tc!.due).toBeGreaterThan(0);
    expect(tc!.late + tc!.missed).toBeGreaterThan(0);
    expect(tc!.escalated).toBeGreaterThanOrEqual(1);
    expect(quality.ratings.length).toBe(1);
  });
});
