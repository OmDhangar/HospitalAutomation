import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { testOrders } from '@/lib/db/schema';
import { parseServicePoint } from '@/lib/domain/test-orders';
import { setConsultationPaid } from '@/lib/services/patient-billing';
import { createDirectAdmission } from '@/lib/services/admissions';
import { orderTests } from '@/lib/services/doctor-ipd';
import { createWard } from '@/lib/services/ipd-config';
import { createWalkIn } from '@/lib/services/queue';
import { markTestOrdersPaid, raiseTestFollowUps } from '@/lib/services/test-order-clock';
import {
  TestOrderError,
  advanceTests,
  assignStaff,
  cancelOrdersForCareEntries,
  cancelTestOrder,
  createIpdTestOrders,
  createServicePoint,
  getTestDay,
  getWorklist,
  listOrderableTests,
  orderOpdTests,
  recordCall,
  removeStaff,
  setTestServicePoint,
} from '@/lib/services/test-orders';

/**
 * Test orders and follow-up against a real database (IPD sheets plan C4a,
 * migration 0047): the doctor sends an OPD patient for tests (once however
 * often the form is sent, billed at the test's price), the clock from the
 * order or from payment, the not-arrived task and its escalation to the admin
 * by the sweep, calls and their outcomes, the steps at the lab, the day view,
 * and the database guards: forward only, append-only calls, clinical key,
 * tenancy, and every step in the evidence log.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Test Follow-up Hospital';
const TZ = 'Asia/Kolkata';
const MIN = 60_000;

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

describe.skipIf(!enabled)('test orders and follow-up (0047)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const app = enabled ? postgres(appUrl!, { max: 1 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const [ownerId, doctorUser, otherDoctorUser, asha, ravi] = [uuid(), uuid(), uuid(), uuid(), uuid()];
  const [cbc, xray, sugar] = [uuid(), uuid(), uuid()];
  let lab = '';
  let xrayRoom = '';
  let patientSeq = 0;

  const visit = async () => {
    patientSeq += 1;
    const { appointment } = await createWalkIn({
      hospitalId,
      branchId,
      doctorId,
      timezone: TZ,
      patient: { phoneE164: `+9197000000${String(patientSeq).padStart(2, '0')}`, name: `Patient ${patientSeq}` },
      whatsappOptIn: false,
    });
    return appointment.id as string;
  };

  const order = (appointmentId: string, chargeItemIds: string[], extra: { formKey?: string; actor?: string; now?: Date } = {}) =>
    orderOpdTests({
      hospitalId,
      appointmentId,
      chargeItemIds,
      formKey: extra.formKey ?? uuid(),
      actorUserId: extra.actor ?? doctorUser,
      seeAll: false,
      now: extra.now,
    });

  const row = async (orderId: string) =>
    (await admin`select * from test_orders where id = ${orderId}`)[0] as Record<string, unknown>;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values
      (${hospitalId}, ${HOSPITAL_NAME}, ${'tf-' + hospitalId.slice(0, 12)}),
      (${otherHospitalId}, ${HOSPITAL_NAME}, ${'tf-' + otherHospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into users (id, email, password_hash, name) values
      (${ownerId}, ${'o-' + ownerId + '@tests.test'}, 'x', 'Owner'),
      (${doctorUser}, ${'d-' + doctorUser + '@tests.test'}, 'x', 'Dr Patil'),
      (${otherDoctorUser}, ${'e-' + otherDoctorUser + '@tests.test'}, 'x', 'Dr Other'),
      (${asha}, ${'a-' + asha + '@tests.test'}, 'x', 'Asha (lab)'),
      (${ravi}, ${'r-' + ravi + '@tests.test'}, 'x', 'Ravi (desk)')`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerId}, ${hospitalId}, 'owner'), (${doctorUser}, ${hospitalId}, 'doctor'), (${otherDoctorUser}, ${hospitalId}, 'doctor'),
      (${asha}, ${hospitalId}, 'receptionist'), (${ravi}, ${hospitalId}, 'receptionist')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Patil', ${doctorUser}, 10)`;
    await admin`insert into charge_items (id, hospital_id, kind, name, unit, selling_price_paise, is_test) values
      (${cbc}, ${hospitalId}, 'service', 'CBC', 'test', 30000, true),
      (${xray}, ${hospitalId}, 'service', 'X-ray chest', 'test', null, true),
      (${sugar}, ${hospitalId}, 'service', 'Blood sugar', 'test', 10000, true)`;

    lab = await createServicePoint({
      hospitalId,
      branchId,
      actorUserId: ownerId,
      input: parseServicePoint({
        kind: 'lab', name: 'Pathology lab', nameMr: 'पॅथॉलॉजी लॅब', floor: 'First floor', section: 'Room 12',
        clockFrom: 'order', clockMinutes: 30,
      }),
    });
    xrayRoom = await createServicePoint({
      hospitalId,
      branchId,
      actorUserId: ownerId,
      input: parseServicePoint({ kind: 'imaging', name: 'X-ray room', clockFrom: 'payment', clockMinutes: 20 }),
    });
    await setTestServicePoint({ hospitalId, chargeItemId: cbc, servicePointId: lab, actorUserId: ownerId });
    await setTestServicePoint({ hospitalId, chargeItemId: xray, servicePointId: xrayRoom, actorUserId: ownerId });
    await assignStaff({ hospitalId, servicePointId: lab, userId: asha, actorUserId: ownerId });
    await assignStaff({ hospitalId, servicePointId: lab, userId: asha, actorUserId: ownerId }); // twice: still one
  });

  afterAll(async () => {
    if (!enabled) return;
    // Orders move forward only and calls are append-only, for everyone; the test's rows go with their hospital.
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['test_follow_up_calls', 'test_orders', 'service_point_staff']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
      await tx.unsafe(`update charge_items set service_point_id = null where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      await tx.unsafe(`delete from service_points where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@tests.test'`;
    await Promise.all([admin.end(), app.end(), closeDb()]);
  });

  it('offers only tests that have an open lab or room', async () => {
    const tests = await listOrderableTests(hospitalId);
    expect(tests.map((t) => t.name)).toEqual(['CBC', 'X-ray chest']);
    const staff = await admin`select count(*)::int as n from service_point_staff where service_point_id = ${lab} and removed_at is null`;
    expect(staff[0].n).toBe(1);
  });

  it('orders OPD tests once however often the form is sent, and bills the priced one', async () => {
    const appointmentId = await visit();
    const formKey = uuid();
    const first = await order(appointmentId, [cbc, xray], { formKey });
    const again = await order(appointmentId, [cbc, xray], { formKey });
    expect(first.map((o) => o.repeat)).toEqual([false, false]);
    expect(again.map((o) => o.orderId).sort()).toEqual(first.map((o) => o.orderId).sort());
    expect(again.every((o) => o.repeat)).toBe(true);

    const rows = await admin`select test_name, bill_item_id, clock_from, due_at, ordered_at from test_orders where appointment_id = ${appointmentId} order by test_name`;
    expect(rows).toHaveLength(2);
    const [cbcRow, xrayRow] = rows;
    expect(cbcRow.bill_item_id).not.toBeNull();
    expect(new Date(cbcRow.due_at).getTime() - new Date(cbcRow.ordered_at).getTime()).toBe(30 * MIN);
    // Unpriced: no bill line; payment clock: no due time until paid.
    expect(xrayRow.bill_item_id).toBeNull();
    expect(xrayRow.due_at).toBeNull();
    const lines = await admin`select total_paise, item_type, charge_item_id from bill_items where id = ${cbcRow.bill_item_id}`;
    expect(lines[0]).toMatchObject({ total_paise: 30000, item_type: 'service', charge_item_id: cbc });
  });

  it('refuses another doctor, a test with no lab, and anything that is not a test', async () => {
    const appointmentId = await visit();
    await expect(order(appointmentId, [cbc], { actor: otherDoctorUser })).rejects.toThrow(/patient’s doctor/);
    await expect(order(appointmentId, [sugar])).rejects.toThrow(/no lab or room/);
    await expect(order(appointmentId, [])).rejects.toThrow(TestOrderError);
  });

  it('starts a "from payment" clock when the desk marks the visit paid', async () => {
    const appointmentId = await visit();
    const [x] = await order(appointmentId, [xray]);
    expect((await row(x.orderId)).due_at).toBeNull();
    await setConsultationPaid({ hospitalId, appointmentId, paid: true, setFeePaise: 20000, actorUserId: ownerId });
    const after = await row(x.orderId);
    expect(after.paid_at).not.toBeNull();
    expect(new Date(after.due_at as string).getTime() - new Date(after.paid_at as string).getTime()).toBe(20 * MIN);
    // Stamped once: a second Paid tap moves nothing.
    expect(await markTestOrdersPaid({ hospitalId, encounterId: after.encounter_id as string })).toBe(0);
  });

  it('raises the not-arrived task after the set time, and to the admin when nobody calls in 15 minutes', async () => {
    const t0 = new Date(Date.now() - 2 * 60 * MIN);
    const [late] = await order(await visit(), [cbc], { now: t0 });
    const [called] = await order(await visit(), [cbc], { now: t0 });

    await raiseTestFollowUps(new Date(t0.getTime() + 29 * MIN));
    expect((await row(late.orderId)).task_raised_at).toBeNull();

    await raiseTestFollowUps(new Date(t0.getTime() + 31 * MIN));
    expect((await row(late.orderId)).task_raised_at).not.toBeNull();
    expect((await row(late.orderId)).escalated_at).toBeNull();

    await recordCall({
      hospitalId, servicePointId: lab, orderIds: [called.orderId], outcome: 'told_the_way', note: null,
      clientId: uuid(), userId: asha, isOwner: false, now: new Date(t0.getTime() + 35 * MIN),
    });
    await raiseTestFollowUps(new Date(t0.getTime() + 46 * MIN));
    expect((await row(late.orderId)).escalated_at).not.toBeNull();
    expect((await row(called.orderId)).escalated_at).toBeNull();

    const list = await getWorklist({ hospitalId, servicePointId: lab, userId: asha, isOwner: false, now: new Date(t0.getTime() + 50 * MIN) });
    const lateCard = list.notArrived.find((p) => p.orders.some((o) => o.id === late.orderId))!;
    const calledCard = list.notArrived.find((p) => p.orders.some((o) => o.id === called.orderId))!;
    expect(lateCard.state).toBe('escalated');
    expect(calledCard.state).toBe('followed_up');
    expect(calledCard.calls[0]).toMatchObject({ outcome: 'told_the_way', calledBy: 'Asha (lab)' });
    // The way is read out in the patient's language, else the hospital's.
    const [lang] = await admin`select coalesce(p.locale::text, h.default_locale::text) as lang from patients p
      join hospitals h on h.id = p.hospital_id where p.id = ${lateCard.patientId}`;
    expect(lateCard.lang).toBe(lang.lang);
    // Most urgent first.
    expect(list.notArrived.findIndex((p) => p === lateCard)).toBeLessThan(list.notArrived.findIndex((p) => p === calledCard));
  });

  it('lets only the lab’s staff (or the owner) work its list, and records whether the caller was assigned', async () => {
    const [o] = await order(await visit(), [cbc]);
    await expect(getWorklist({ hospitalId, servicePointId: lab, userId: ravi, isOwner: false })).rejects.toThrow(/not on the staff/);
    await recordCall({ hospitalId, servicePointId: lab, orderIds: [o.orderId], outcome: 'no_answer', note: null, clientId: uuid(), userId: ownerId, isOwner: true });
    const calls = await admin`select caller_assigned from test_follow_up_calls where order_id = ${o.orderId}`;
    expect(calls.map((c) => c.caller_assigned)).toEqual([false]);

    await assignStaff({ hospitalId, servicePointId: lab, userId: ravi, actorUserId: ownerId });
    await expect(getWorklist({ hospitalId, servicePointId: lab, userId: ravi, isOwner: false })).resolves.toBeTruthy();
    await removeStaff({ hospitalId, servicePointId: lab, userId: ravi, actorUserId: ownerId });
    await expect(getWorklist({ hospitalId, servicePointId: lab, userId: ravi, isOwner: false })).rejects.toThrow(/not on the staff/);
  });

  it('records a call once per test, and "refused" closes the tests as not coming', async () => {
    const appointmentId = await visit();
    const both = await order(appointmentId, [cbc]);
    const clientId = uuid();
    const call = () =>
      recordCall({ hospitalId, servicePointId: lab, orderIds: both.map((o) => o.orderId), outcome: 'refused_cost', note: 'Too costly', clientId, userId: asha, isOwner: false });
    expect(await call()).toEqual({ recorded: 1, closed: 1 });
    expect(await call()).toEqual({ recorded: 0, closed: 0 });
    expect(await row(both[0].orderId)).toMatchObject({ status: 'not_coming', closed_reason: 'refused_cost', closed_note: 'Too costly' });
    await expect(
      recordCall({ hospitalId, servicePointId: lab, orderIds: [both[0].orderId], outcome: 'refused_other', note: null, clientId: uuid(), userId: asha, isOwner: false }),
    ).rejects.toThrow(/what the patient said/);
  });

  it('moves tests forward at the lab, never back, and the database holds the line', async () => {
    const [o] = await order(await visit(), [cbc]);
    const step = (to: 'arrived' | 'done' | 'reported') =>
      advanceTests({ hospitalId, servicePointId: lab, orderIds: [o.orderId], to, userId: asha, isOwner: false });
    expect(await step('done')).toBe(1); // tested on arrival: arrival stamped with it
    expect(await row(o.orderId)).toMatchObject({ status: 'done', arrived_by_user_id: asha, done_by_user_id: asha });
    expect(await step('arrived')).toBe(0);
    expect(await step('reported')).toBe(1);
    await expect(advanceTests({ hospitalId, servicePointId: xrayRoom, orderIds: [o.orderId], to: 'done', userId: ownerId, isOwner: true })).rejects.toThrow(/not found at this lab/);

    // Straight at the database, as the app role with the clinical key: no going back, no rewriting, no deleting.
    const asApp = (q: string) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.hospital_id', ${hospitalId}, true), set_config('app.clinical_access', 'true', true)`;
        await tx.unsafe(q);
      });
    await rejectsWith(asApp(`update test_orders set status = 'arrived', done_at = null, done_by_user_id = null, reported_at = null, reported_by_user_id = null where id = '${o.orderId}'`), /already set|cannot go from/);
    await rejectsWith(asApp(`update test_orders set test_name = 'ESR' where id = '${o.orderId}'`), /cannot be changed/);
    await rejectsWith(asApp(`delete from test_orders where id = '${o.orderId}'`), /permission denied|cannot be deleted/);
    await rejectsWith(asApp(`update test_follow_up_calls set outcome = 'coming_now' where hospital_id = '${hospitalId}'`), /permission denied/);
  });

  it('cancels a mistaken order with its unpaid bill line, by the doctor who ordered it', async () => {
    const [o] = await order(await visit(), [cbc]);
    await expect(cancelTestOrder({ hospitalId, orderId: o.orderId, actorUserId: otherDoctorUser, isOwner: false, reason: '' })).rejects.toThrow(/who ordered/);
    await cancelTestOrder({ hospitalId, orderId: o.orderId, actorUserId: doctorUser, isOwner: false, reason: 'Wrong patient' });
    const r = await row(o.orderId);
    expect(r).toMatchObject({ status: 'cancelled', closed_note: 'Wrong patient' });
    const line = await admin`select voided_at from bill_items where id = ${r.bill_item_id as string}`;
    expect(line[0].voided_at).not.toBeNull();
  });

  it('keeps test orders behind the clinical key and inside the hospital', async () => {
    const plain = await withTenant(hospitalId, (tx) => tx.select({ id: testOrders.id }).from(testOrders));
    expect(plain).toEqual([]);
    const other = await withTenant(otherHospitalId, (tx) => tx.select({ id: testOrders.id }).from(testOrders), { clinical: true });
    expect(other).toEqual([]);
    const mine = await withTenant(hospitalId, (tx) => tx.select({ id: testOrders.id }).from(testOrders), { clinical: true });
    expect(mine.length).toBeGreaterThan(5);
  });

  it('shows the day per lab and per person, with the pending list', async () => {
    const day = await getTestDay({ hospitalId });
    const labDay = day.points.find((p) => p.id === lab)!.summary;
    // Ordered that day in hospital time (the escalation test's orders are two hours old, maybe yesterday's).
    const [{ n }] = await admin`select count(*)::int as n from test_orders where service_point_id = ${lab}
      and (ordered_at at time zone 'Asia/Kolkata')::date = ${day.date}::date`;
    expect(labDay.ordered).toBe(n);
    expect(labDay.notComing).toBe(1);
    expect(labDay.reported).toBe(1);
    expect(labDay.cancelled).toBe(1);
    expect(day.people.find((p) => p.userId === asha)).toMatchObject({ testsDone: 1, arrivalsMarked: 1 });
    expect(day.pending.every((p) => ['ordered', 'arrived', 'done'].includes(p.status))).toBe(true);
    expect(day.escalatedOpen).toBeGreaterThanOrEqual(1);
  });

  it('puts every step in the evidence log', async () => {
    const events = await admin`select action, count(*)::int as n from acct_events where hospital_id = ${hospitalId}
      and (action like 'test_%' or action like 'service_point%') group by action`;
    const byAction = Object.fromEntries(events.map((e) => [e.action, e.n]));
    expect(byAction['service_point.created']).toBe(2);
    expect(byAction['service_point_staff.created']).toBeGreaterThanOrEqual(2);
    expect(byAction['service_point_staff.changed']).toBeGreaterThanOrEqual(1);
    expect(byAction['test_order.created']).toBeGreaterThanOrEqual(8);
    expect(byAction['test_order.changed']).toBeGreaterThanOrEqual(5);
    expect(byAction['test_call.created']).toBeGreaterThanOrEqual(3);
    // The sweep's stamps are the system's: no person.
    const raised = await admin`select actor_user_id from acct_events where hospital_id = ${hospitalId}
      and action = 'test_order.changed' and payload ? 'escalated_at' limit 1`;
    expect(raised[0].actor_user_id).toBeNull();
  });

  it('puts a ward test on its lab’s list once, counting from the order, and takes it back with the doctor’s undo', async () => {
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerId });
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    const { admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919700000099', name: 'Ward Patient' },
      bedId: bed.id as string,
      actorUserId: ownerId,
    });
    const results = await orderTests({ hospitalId, admissionId, chargeItemIds: [cbc, sugar], formKey: uuid(), actorUserId: doctorUser, seeAll: false });
    const entryIds = results.flatMap((r) => (r.ok ? [r.entryId] : []));
    expect(entryIds).toHaveLength(2);

    // Blood sugar has no lab: billed as before, not followed up.
    expect(await createIpdTestOrders({ hospitalId, admissionId, careEntryIds: entryIds, actorUserId: doctorUser })).toBe(1);
    expect(await createIpdTestOrders({ hospitalId, admissionId, careEntryIds: entryIds, actorUserId: doctorUser })).toBe(0);
    const [ward] = await admin`select * from test_orders where admission_id = ${admissionId}`;
    expect(ward).toMatchObject({ setting: 'ipd', clock_from: 'order', test_name: 'CBC', service_point_id: lab });

    const list = await getWorklist({ hospitalId, servicePointId: lab, userId: asha, isOwner: false });
    expect(list.notArrived.find((p) => p.setting === 'ipd')?.where).toBe('Ward A · Bed 1');

    expect(await cancelOrdersForCareEntries({ hospitalId, careEntryIds: entryIds, actorUserId: doctorUser })).toBe(1);
    expect((await row(ward.id as string)).status).toBe('cancelled');
  });
});
