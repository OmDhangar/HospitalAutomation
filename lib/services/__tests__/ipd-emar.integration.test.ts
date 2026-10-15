import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';
import {
  signRoundOrders,
} from '@/lib/services/ipd-medication-orders';
import {
  getBedsideEmar,
  recordAdministration,
  recordException,
  voidAdministration,
  correctAdministration,
} from '@/lib/services/ipd-emar';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

const ids = {
  hospitalA: uuid(),
  branchA: uuid(),
  doctorA: uuid(),
  nurseUserA: uuid(),
  nurseUserB: uuid(),
  patientA: uuid(),
  encounterA: uuid(),
  admissionA: uuid(),
  medicineParacetamol: uuid(),
  medicineCeftriaxone: uuid(),
  medicineTramadol: uuid(),
};

describe.skipIf(!enabled)('ipd-emar service', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'eMAR Bedside Hospital', ${'bed-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Branch A')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.nurseUserA}, ${'nurse-a-' + ids.nurseUserA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Nurse Priya'),
        (${ids.nurseUserB}, ${'nurse-b-' + ids.nurseUserB.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Nurse Deepa')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr Attending', ${ids.nurseUserA})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000401',
      name: 'Vikas Sharma',
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
      insert into medicines (id, hospital_id, name, generic_name, unit, selling_price_paise) values
        (${ids.medicineParacetamol}, ${ids.hospitalA}, 'Paracetamol 500mg Tab', 'Paracetamol', 'tablet', 250),
        (${ids.medicineCeftriaxone}, ${ids.hospitalA}, 'Ceftriaxone 1g Inj', 'Ceftriaxone', 'vial', 45000),
        (${ids.medicineTramadol}, ${ids.hospitalA}, 'Tramadol 50mg Inj', 'Tramadol', 'ampoule', 6000)
    `;
    await admin`
      insert into ipd_allergy_assessments
        (hospital_id, admission_id, encounter_id, patient_id, status, is_current, reviewed_by_user_id, reviewed_at)
      values
        (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, 'nkda', true, ${ids.nurseUserA}, now())
    `;
  });

  afterAll(async () => {
    try {
      await admin`set session_replication_role = 'replica'`;
      await admin`delete from ipd_allergy_assessments where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_emar_integration_outbox where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_medication_administrations where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_medication_order_actions where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_medication_orders where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_clinical_rounds where hospital_id = ${ids.hospitalA}`;
      await admin`delete from hospitals where id = ${ids.hospitalA}`;
    } finally {
      await admin`set session_replication_role = 'origin'`;
      await admin.end();
    }
  });

  it('organizes scheduled orders into dueNow, upcoming, and PRN buckets on bedside eMAR', async () => {
    // Prescribe Ceftriaxone BD (08:00, 20:00) and Paracetamol PRN
    await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Initial admission medication regimen',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicineCeftriaxone,
            medicineName: 'Ceftriaxone 1g Inj',
            doseAmount: '1000',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'scheduled',
            frequencyCode: 'BD',
            scheduleTimes: ['08:00', '20:00'],
            startsAt: new Date('2026-10-12T06:00:00+05:30'),
            durationDays: 3,
          },
        },
        {
          type: 'new',
          order: {
            medicineId: ids.medicineParacetamol,
            medicineName: 'Paracetamol 500mg Tab',
            doseAmount: '500',
            doseUnit: 'mg',
            route: 'oral',
            scheduleType: 'prn',
            isPrn: true,
            prnIndication: 'Fever > 38.5 C or pain',
            prnMaxDailyDoses: 4,
            prnMinIntervalHours: 4,
            startsAt: new Date('2026-10-12T06:00:00+05:30'),
          },
        },
      ],
    });

    // Check eMAR at 08:15 AM
    const emar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T08:15:00+05:30'),
    });

    // 08:00 dose is within [-60, +60] window at 08:15 -> dueNow
    expect(emar.dueNow.length).toBeGreaterThanOrEqual(1);
    expect(emar.dueNow[0].medicineName).toBe('Ceftriaxone 1g Inj');

    // PRN orders are available
    expect(emar.prn.length).toBeGreaterThanOrEqual(1);
    expect(emar.prn[0].medicineName).toBe('Paracetamol 500mg Tab');
    expect(emar.prn[0].eligibility.eligible).toBe(true);
  });

  it('records scheduled dose administration idempotently and enqueues billing outbox event', async () => {
    const emar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T08:15:00+05:30'),
    });
    const dueItem = emar.dueNow[0];
    const clientId = uuid();

    // First administration
    const res1 = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: dueItem.orderId,
      input: {
        clientId,
        scheduledTime: dueItem.scheduledTime,
        actualTime: new Date('2026-10-12T08:20:00+05:30'),
        doseAmount: '1000',
        doseGiven: '1000 mg',
        routeGiven: 'iv_push',
      },
      actorUserId: ids.nurseUserA,
    });

    expect(res1.ok).toBe(true);
    expect(res1.administrationId).toBeDefined();

    // Outbox billing event was enqueued
    const outboxRows = await admin`
      select event_type, integration_type, status from ipd_emar_integration_outbox
      where administration_id = ${res1.administrationId}
    `;
    expect(outboxRows).toHaveLength(1);
    expect(outboxRows[0].event_type).toBe('administer');
    expect(outboxRows[0].integration_type).toBe('billing');
    expect(outboxRows[0].status).toBe('pending');

    // Idempotent retry with same clientId returns existing record
    const res2 = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: dueItem.orderId,
      input: {
        clientId,
        scheduledTime: dueItem.scheduledTime,
        actualTime: new Date('2026-10-12T08:20:00+05:30'),
        doseAmount: '1000',
        doseGiven: '1000 mg',
        routeGiven: 'iv_push',
      },
      actorUserId: ids.nurseUserA,
    });

    expect(res2.administrationId).toBe(res1.administrationId);
  });

  it('immediately completes a stat order upon administration', async () => {
    // Prescribe Stat dose
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Emergency stat pain relief',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicineTramadol,
            medicineName: 'Tramadol 50mg Inj',
            doseAmount: '50',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'stat',
            scheduleTimes: ['now'],
            startsAt: new Date(),
          },
        },
      ],
    });

    const statOrderId = signRes.signedOrderIds[0];

    // Administer stat dose
    await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: statOrderId,
      input: {
        clientId: uuid(),
        actualTime: new Date(),
        doseAmount: '50',
        doseGiven: '50 mg',
        routeGiven: 'iv_push',
      },
      actorUserId: ids.nurseUserA,
    });

    // Stat order must now be completed
    const [statOrder] = await admin`
      select status from ipd_medication_orders where id = ${statOrderId}
    `;
    expect(statOrder.status).toBe('completed');
  });

  it('enforces PRN cooldown interval across consecutive administrations', async () => {
    const emar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T10:00:00+05:30'),
    });
    const prnOrder = emar.prn.find((p) => p.medicineName.includes('Paracetamol'))!;

    // First PRN dose at 10:00 AM
    await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: prnOrder.orderId,
      input: {
        clientId: uuid(),
        actualTime: new Date('2026-10-12T10:00:00+05:30'),
        doseAmount: '500',
        doseGiven: '500 mg',
        routeGiven: 'oral',
      },
      actorUserId: ids.nurseUserA,
    });

    // Second PRN dose at 11:30 AM (only 1.5h later; 4h cooldown required) -> must fail
    await expect(
      recordAdministration({
        hospitalId: ids.hospitalA,
        admissionId: ids.admissionA,
        orderId: prnOrder.orderId,
        input: {
          clientId: uuid(),
          actualTime: new Date('2026-10-12T11:30:00+05:30'),
          doseAmount: '500',
          doseGiven: '500 mg',
          routeGiven: 'oral',
        },
        actorUserId: ids.nurseUserB,
      }),
    ).rejects.toThrow(/cooldown/i);
  });

  it('records administration exceptions (omitted/held/refused) with mandatory reason', async () => {
    const emar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T20:00:00+05:30'),
    });
    const dueItem = emar.dueNow[0];

    const excRes = await recordException({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: dueItem.orderId,
      input: {
        clientId: uuid(),
        scheduledTime: dueItem.scheduledTime,
        outcome: 'refused',
        nonAdminReason: 'Patient refused medication due to nausea',
      },
      actorUserId: ids.nurseUserA,
    });

    expect(excRes.ok).toBe(true);

    const [adminRow] = await admin`
      select outcome, non_admin_reason, actual_time, decision_time
      from ipd_medication_administrations where id = ${excRes.administrationId}
    `;
    expect(adminRow.outcome).toBe('refused');
    expect(adminRow.non_admin_reason).toBe('Patient refused medication due to nausea');
    expect(adminRow.actual_time).toBeNull();
    expect(adminRow.decision_time).not.toBeNull();
  });

  it('voids an erroneous administration and enqueues void event for billing reversal', async () => {
    const emar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    const prnOrder = emar.prn[0];

    // Give dose at 15:00 (after cooldown from 10:00)
    const adminRes = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: prnOrder.orderId,
      input: {
        clientId: uuid(),
        actualTime: new Date('2026-10-12T15:00:00+05:30'),
        doseAmount: '500',
        doseGiven: '500 mg',
        routeGiven: 'oral',
      },
      actorUserId: ids.nurseUserA,
    });

    // Void the administration
    const voidRes = await voidAdministration({
      hospitalId: ids.hospitalA,
      administrationId: adminRes.administrationId,
      reason: 'Logged against wrong chart in error',
      actorUserId: ids.nurseUserA,
    });

    expect(voidRes.success).toBe(true);

    // Verify outbox has void event
    const voidOutbox = await admin`
      select event_type, status from ipd_emar_integration_outbox
      where administration_id = ${adminRes.administrationId} and event_type = 'void'
    `;
    expect(voidOutbox).toHaveLength(1);
    expect(voidOutbox[0].status).toBe('pending');
  });

  it('corrects an administration by voiding original and creating linked replacement', async () => {
    const emar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
    });
    const prnOrder = emar.prn[0];

    // Administer 500mg
    const originalRes = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: prnOrder.orderId,
      input: {
        clientId: uuid(),
        actualTime: new Date('2026-10-12T21:00:00+05:30'),
        doseAmount: '500',
        doseGiven: '500 mg',
        routeGiven: 'oral',
      },
      actorUserId: ids.nurseUserA,
    });

    // Correct to 650mg
    const correctionRes = await correctAdministration({
      hospitalId: ids.hospitalA,
      administrationId: originalRes.administrationId,
      correctedInput: {
        clientId: uuid(),
        actualTime: new Date('2026-10-12T21:00:00+05:30'),
        doseAmount: '650',
        doseGiven: '650 mg',
        routeGiven: 'oral',
      },
      reason: 'Patient took 650mg tablet, not 500mg',
      actorUserId: ids.nurseUserA,
    });

    expect(correctionRes.ok).toBe(true);
    expect(correctionRes.administrationId).not.toBe(originalRes.administrationId);

    // Verify linkage in DB
    const [orig] = await admin`
      select voided_at, corrected_by_administration_id from ipd_medication_administrations
      where id = ${originalRes.administrationId}
    `;
    expect(orig.voided_at).not.toBeNull();
    expect(orig.corrected_by_administration_id).toBe(correctionRes.administrationId);

    const [corrected] = await admin`
      select corrects_administration_id, dose_amount_numeric from ipd_medication_administrations
      where id = ${correctionRes.administrationId}
    `;
    expect(corrected.corrects_administration_id).toBe(originalRes.administrationId);
    expect(Number(corrected.dose_amount_numeric)).toBe(650);
  });
});
