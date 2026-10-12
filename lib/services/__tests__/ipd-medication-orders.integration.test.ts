import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';
import {
  listActiveOrders,
  saveRoundDraft,
  signRoundOrders,
  executeOrderAction,
  voidOrder,
} from '@/lib/services/ipd-medication-orders';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

const ids = {
  hospitalA: uuid(),
  branchA: uuid(),
  doctorA: uuid(),
  userA: uuid(),
  patientA: uuid(),
  encounterA: uuid(),
  admissionA: uuid(),
  medicineA: uuid(),
  medicineB: uuid(),
};

describe.skipIf(!enabled)('ipd-medication-orders service', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Order Test Hospital', ${'ord-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Branch A')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.userA}, ${'doc-ord-' + ids.userA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Dr Rounds')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr Rounds', ${ids.userA})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000301',
      name: 'Sunita Rao',
    });
    await admin`
      insert into encounters
        (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage)
      values
        (${ids.encounterA}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA}, ${ids.doctorA}, 'emergency', 'ipd')
    `;
    await admin`
      insert into admissions
        (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id, status, admitted_at)
      values
        (${ids.admissionA}, ${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA}, ${ids.branchA}, ${ids.doctorA}, 'admitted', now())
    `;
    await admin`
      insert into medicines (id, hospital_id, name, generic_name, unit) values
        (${ids.medicineA}, ${ids.hospitalA}, 'Ceftriaxone 1g Inj', 'Ceftriaxone', 'vial'),
        (${ids.medicineB}, ${ids.hospitalA}, 'Paracetamol 500mg Tab', 'Paracetamol', 'tablet')
    `;
  });

  afterAll(async () => {
    try {
      await admin`set session_replication_role = 'replica'`;
      await admin`delete from ipd_medication_order_actions where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_medication_orders where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_clinical_rounds where hospital_id = ${ids.hospitalA}`;
      await admin`delete from hospitals where id = ${ids.hospitalA}`;
    } finally {
      await admin`set session_replication_role = 'origin'`;
      await admin.end();
    }
  });

  it('saves round draft and does not make draft orders actionable', async () => {
    const draftRes = await saveRoundDraft({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.userA,
      notes: 'Patient resting comfortably. Vitals stable.',
      draftOrders: [
        {
          medicineId: ids.medicineA,
          medicineName: 'Ceftriaxone 1g Inj',
          doseAmount: '1000',
          doseUnit: 'mg',
          route: 'iv_push',
          scheduleType: 'scheduled',
          frequencyCode: 'BD',
          scheduleTimes: ['08:00', '20:00'],
          durationDays: 5,
        },
      ],
    });

    expect(draftRes.roundId).toBeDefined();

    // Active orders query must NOT return draft orders
    const active = await listActiveOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    expect(active.length).toBe(0);
  });

  it('signs round orders and creates immutable active orders with action audit history', async () => {
    const endsAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.userA,
      notes: 'Morning round: commence IV antibiotics course.',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicineA,
            medicineName: 'Ceftriaxone 1g Inj',
            doseAmount: '1000',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'scheduled',
            frequencyCode: 'BD',
            scheduleTimes: ['08:00', '20:00'],
            startsAt: new Date(),
            endsAt,
            durationDays: 5,
          },
        },
      ],
    });

    expect(signRes.roundId).toBeDefined();
    expect(signRes.signedOrderIds).toHaveLength(1);

    const active = await listActiveOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    expect(active).toHaveLength(1);
    expect(active[0].status).toBe('active');
    expect(active[0].medicineName).toBe('Ceftriaxone 1g Inj');

    // Audit action row should exist
    const actions = await admin`
      select action, doctor_id from ipd_medication_order_actions
      where order_id = ${signRes.signedOrderIds[0]}
    `;
    expect(actions).toHaveLength(1);
    expect(actions[0].action).toBe('sign');
    expect(actions[0].doctor_id).toBe(ids.doctorA);
  });

  it('renews an active order via successor version without mutating prior signed order in place', async () => {
    const active = await listActiveOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    const orderToRenew = active[0];

    const newEndsAt = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
    const renewRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.userA,
      notes: 'Evening round: extend antibiotic course by 5 days.',
      resolutions: [
        {
          type: 'renew',
          orderId: orderToRenew.id,
          newEndsAt,
        },
      ],
    });

    expect(renewRes.signedOrderIds).toHaveLength(1);
    const newOrderId = renewRes.signedOrderIds[0];

    // Prior order is now superseded
    const [priorOrder] = await admin`
      select status, supersedes_order_id, superseded_by_order_id, order_chain_id
      from ipd_medication_orders where id = ${orderToRenew.id}
    `;
    expect(priorOrder.status).toBe('superseded');
    expect(priorOrder.superseded_by_order_id).toBe(newOrderId);

    // New order is active and shares the same chain
    const [newOrder] = await admin`
      select status, supersedes_order_id, order_chain_id
      from ipd_medication_orders where id = ${newOrderId}
    `;
    expect(newOrder.status).toBe('active');
    expect(newOrder.supersedes_order_id).toBe(orderToRenew.id);
    expect(newOrder.order_chain_id).toBe(priorOrder.order_chain_id);
  });

  it('modifies an active order via successor version with new dosage', async () => {
    const active = await listActiveOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    const orderToModify = active[0];

    const modRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.userA,
      notes: 'Reduce dosage to 500mg OD.',
      resolutions: [
        {
          type: 'modify',
          orderId: orderToModify.id,
          modifiedOrder: {
            doseAmount: '500',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'scheduled',
            frequencyCode: 'OD',
            scheduleTimes: ['08:00'],
            endsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
          },
        },
      ],
    });

    expect(modRes.signedOrderIds).toHaveLength(1);
    const modOrderId = modRes.signedOrderIds[0];

    const [modifiedOrder] = await admin`
      select status, dose_amount, frequency_code, supersedes_order_id, order_chain_id
      from ipd_medication_orders where id = ${modOrderId}
    `;
    expect(modifiedOrder.status).toBe('active');
    expect(Number(modifiedOrder.dose_amount)).toBe(500);
    expect(modifiedOrder.frequency_code).toBe('OD');
    expect(modifiedOrder.supersedes_order_id).toBe(orderToModify.id);
  });

  it('executes ad-hoc order actions between rounds (hold and resume)', async () => {
    const active = await listActiveOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    const order = active[0];

    // Hold order
    const holdRes = await executeOrderAction({
      hospitalId: ids.hospitalA,
      orderId: order.id,
      action: 'hold',
      reason: 'NPO for scheduled procedure',
      actorUserId: ids.userA,
      doctorId: ids.doctorA,
    });
    expect(holdRes.success).toBe(true);
    expect(holdRes.nextStatus).toBe('on_hold');

    // Resume order
    const resumeRes = await executeOrderAction({
      hospitalId: ids.hospitalA,
      orderId: order.id,
      action: 'resume',
      reason: 'Procedure complete, cleared for oral intake',
      actorUserId: ids.userA,
      doctorId: ids.doctorA,
    });
    expect(resumeRes.success).toBe(true);
    expect(resumeRes.nextStatus).toBe('active');
  });

  it('voids an erroneously entered order with structured audit lineage', async () => {
    // Prescribe a medication by mistake
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.userA,
      notes: 'Prescribe Paracetamol',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicineB,
            medicineName: 'Paracetamol 500mg Tab',
            doseAmount: '500',
            doseUnit: 'mg',
            route: 'oral',
            scheduleType: 'scheduled',
            frequencyCode: 'TDS',
            scheduleTimes: ['08:00', '14:00', '20:00'],
            startsAt: new Date(),
          },
        },
      ],
    });

    const orderToVoidId = signRes.signedOrderIds[0];

    // Void the order
    const voidRes = await voidOrder({
      hospitalId: ids.hospitalA,
      orderId: orderToVoidId,
      reason: 'Entered on wrong patient bed chart',
      actorUserId: ids.userA,
    });
    expect(voidRes.success).toBe(true);

    const [voidedOrder] = await admin`
      select status, void_reason, voided_at, voided_by_user_id
      from ipd_medication_orders where id = ${orderToVoidId}
    `;
    expect(voidedOrder.status).toBe('voided');
    expect(voidedOrder.void_reason).toBe('Entered on wrong patient bed chart');
    expect(voidedOrder.voided_by_user_id).toBe(ids.userA);
  });
});
