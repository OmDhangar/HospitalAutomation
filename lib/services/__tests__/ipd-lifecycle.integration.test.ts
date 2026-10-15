import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';
import {
  signRoundOrders,
} from '@/lib/services/ipd-medication-orders';
import {
  getBedsideEmar,
  recordAdministration,
} from '@/lib/services/ipd-emar';
import {
  processPendingOutboxBatch,
} from '@/lib/services/ipd-emar-outbox';

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
  medicineCeftriaxone: uuid(),
  medicineTramadol: uuid(),
  medicineOndansetron: uuid(),
};

describe.skipIf(!enabled)('IPD eMAR End-to-End Clinical Lifecycle', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Lifecycle Test Hospital', ${'e2e-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Main Branch')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.nurseUserA}, ${'nurse-lead-' + ids.nurseUserA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Nurse Lead'),
        (${ids.nurseUserB}, ${'nurse-ward-' + ids.nurseUserB.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Nurse Ward')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr Attending Rounds', ${ids.nurseUserA})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000601',
      name: 'Sunita Devi',
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
        (${ids.medicineCeftriaxone}, ${ids.hospitalA}, 'Ceftriaxone 1g Inj', 'Ceftriaxone', 'vial', 45000),
        (${ids.medicineTramadol}, ${ids.hospitalA}, 'Tramadol 50mg Inj', 'Tramadol', 'ampoule', 6000),
        (${ids.medicineOndansetron}, ${ids.hospitalA}, 'Ondansetron 4mg Inj', 'Ondansetron', 'ampoule', 3500)
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
      await admin`delete from bill_items where hospital_id = ${ids.hospitalA}`;
      await admin`delete from bills where hospital_id = ${ids.hospitalA}`;
      await admin`delete from care_entries where hospital_id = ${ids.hospitalA}`;
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

  it('completes the entire closed-loop medication management cycle seamlessly', async () => {
    // -------------------------------------------------------------------------
    // Phase 1: Attending doctor evaluates patient and signs morning round orders
    // -------------------------------------------------------------------------
    const morningSignRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Morning rounds: Patient febrile with acute abdominal pain and nausea. Starting IV antibiotics, antiemetic stat, and analgesia PRN.',
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
            startsAt: new Date('2026-10-12T07:00:00+05:30'),
            durationDays: 5,
          },
        },
        {
          type: 'new',
          order: {
            medicineId: ids.medicineTramadol,
            medicineName: 'Tramadol 50mg Inj',
            doseAmount: '50',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'prn',
            prnIndication: 'Severe abdominal pain > 7/10',
            prnMinIntervalHours: 4, // 4-hour cooldown
            prnMaxDailyDoses: 4,
            startsAt: new Date('2026-10-12T07:00:00+05:30'),
          },
        },
        {
          type: 'new',
          order: {
            medicineId: ids.medicineOndansetron,
            medicineName: 'Ondansetron 4mg Inj',
            doseAmount: '4',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'stat',
            scheduleTimes: ['now'],
            startsAt: new Date('2026-10-12T07:00:00+05:30'),
          },
        },
      ],
    });

    expect(morningSignRes.signedOrderIds).toHaveLength(3);
    const [scheduledCeftriaxoneId, prnTramadolId, statOndansetronId] = morningSignRes.signedOrderIds;

    // -------------------------------------------------------------------------
    // Phase 2: Bedside eMAR shows scheduled in dueNow, PRN in prn, and Stat in dueNow
    // -------------------------------------------------------------------------
    const morningEmar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T08:15:00+05:30'),
    });

    // Stat order should be in dueNow
    const dueStat = morningEmar.dueNow.find((d) => d.orderId === statOndansetronId);
    expect(dueStat).toBeDefined();
    expect(dueStat?.scheduleType).toBe('stat');

    // Scheduled Ceftriaxone 08:00 slot should be in dueNow
    const dueScheduled = morningEmar.dueNow.find((d) => d.orderId === scheduledCeftriaxoneId);
    expect(dueScheduled).toBeDefined();
    expect(dueScheduled?.scheduledTime).toEqual(new Date('2026-10-12T08:00:00+05:30'));

    // PRN Tramadol should be in prn bucket
    const prnTramadol = morningEmar.prn.find((p) => p.orderId === prnTramadolId);
    expect(prnTramadol).toBeDefined();
    expect(prnTramadol?.prnMinIntervalHours).toBe(4);

    // Upcoming should have the 20:00 evening dose
    const upcomingEvening = morningEmar.upcoming.find((u) => u.orderId === scheduledCeftriaxoneId);
    expect(upcomingEvening).toBeDefined();
    expect(upcomingEvening?.scheduledTime).toEqual(new Date('2026-10-12T20:00:00+05:30'));

    // -------------------------------------------------------------------------
    // Phase 3: Nurse administers the Stat dose (Ondansetron)
    // -------------------------------------------------------------------------
    const statAdminTime = new Date('2026-10-12T08:18:00+05:30');
    const statAdminRes = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: statOndansetronId,
      input: {
        clientId: uuid(),
        actualTime: statAdminTime,
        doseAmount: '4',
        doseGiven: '4 mg',
        routeGiven: 'iv_push',
        notes: 'Administered over 2 minutes via IV cannula in left forearm.',
      },
      actorUserId: ids.nurseUserA,
    });

    expect(statAdminRes.administrationId).toBeDefined();

    // Verify stat order is now 'completed' in DB
    const [statOrderDb] = await admin`
      select status from ipd_medication_orders
      where id = ${statOndansetronId}
    `;
    expect(statOrderDb.status).toBe('completed');

    // Bedside eMAR should no longer show Stat in dueNow
    const emarAfterStat = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T08:20:00+05:30'),
    });
    expect(emarAfterStat.dueNow.find((d) => d.orderId === statOndansetronId)).toBeUndefined();

    // -------------------------------------------------------------------------
    // Phase 4: Nurse administers Scheduled dose & background worker posts billing
    // -------------------------------------------------------------------------
    const schedAdminTime = new Date('2026-10-12T08:25:00+05:30');
    const schedAdminRes = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: scheduledCeftriaxoneId,
      input: {
        clientId: uuid(),
        scheduledTime: new Date('2026-10-12T08:00:00+05:30'),
        actualTime: schedAdminTime,
        doseAmount: '1000',
        doseGiven: '1000 mg',
        routeGiven: 'iv_push',
        notes: 'Reconstituted with 10ml sterile water, given slow IV push.',
      },
      actorUserId: ids.nurseUserA,
    });

    expect(schedAdminRes.administrationId).toBeDefined();

    // Verify outbox worker processes pending integration events
    const processedWorker = await processPendingOutboxBatch({ hospitalId: ids.hospitalA, limit: 10 });
    expect(processedWorker.processed).toBeGreaterThanOrEqual(2); // Stat + Scheduled

    // Verify care entry and bill items were generated
    const [adminRow] = await admin`
      select care_entry_id from ipd_medication_administrations
      where id = ${schedAdminRes.administrationId}
    `;
    expect(adminRow.care_entry_id).toBeDefined();

    const [careEntry] = await admin`
      select * from care_entries
      where id = ${adminRow.care_entry_id}
    `;
    expect(careEntry).toBeDefined();

    const [billItem] = await admin`
      select * from bill_items
      where care_entry_id = ${careEntry.id}
    `;
    expect(billItem).toBeDefined();
    expect(Number(billItem.unit_price_paise)).toBe(45000); // Ceftriaxone price

    // -------------------------------------------------------------------------
    // Phase 5: Nurse administers PRN dose & cooldown enforcement
    // -------------------------------------------------------------------------
    const prnAdminTime1 = new Date('2026-10-12T09:00:00+05:30');
    const prnAdminRes1 = await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: prnTramadolId,
      input: {
        clientId: uuid(),
        actualTime: prnAdminTime1,
        doseAmount: '50',
        doseGiven: '50 mg',
        routeGiven: 'iv_push',
        notes: 'Patient reports severe pain 8/10. Administered Tramadol.',
      },
      actorUserId: ids.nurseUserB,
    });
    expect(prnAdminRes1.administrationId).toBeDefined();

    // Rapid attempt 60 minutes later (within 4-hour cooldown) MUST reject
    const prnAdminTime2 = new Date('2026-10-12T10:00:00+05:30');
    await expect(
      recordAdministration({
        hospitalId: ids.hospitalA,
        admissionId: ids.admissionA,
        orderId: prnTramadolId,
        input: {
          clientId: uuid(),
          actualTime: prnAdminTime2,
          doseAmount: '50',
          doseGiven: '50 mg',
          routeGiven: 'iv_push',
        },
        actorUserId: ids.nurseUserB,
      }),
    ).rejects.toThrow(/Cooldown interval has not elapsed/i);

    // -------------------------------------------------------------------------
    // Phase 6: Doctor modifies Scheduled order in evening round
    // -------------------------------------------------------------------------
    // Doctor increases Ceftriaxone dose to 2000mg for evening round
    const eveningSignRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Evening rounds: Escalating Ceftriaxone to 2g BD due to persistent high fever spike.',
      resolutions: [
        {
          type: 'modify',
          orderId: scheduledCeftriaxoneId,
          reason: 'Escalating Ceftriaxone to 2000mg BD for persistent sepsis fever spike',
          modifiedOrder: {
            medicineId: ids.medicineCeftriaxone,
            medicineName: 'Ceftriaxone 2g Inj',
            doseAmount: '2000',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'scheduled',
            frequencyCode: 'BD',
            scheduleTimes: ['08:00', '20:00'],
            startsAt: new Date('2026-10-12T18:00:00+05:30'),
            durationDays: 4,
          },
        },
      ],
    });

    expect(eveningSignRes.signedOrderIds).toHaveLength(1);
    const modifiedOrderId = eveningSignRes.signedOrderIds[0];

    // Prior order must be marked superseded
    const [priorOrderDb] = await admin`
      select status, superseded_by_order_id from ipd_medication_orders
      where id = ${scheduledCeftriaxoneId}
    `;
    expect(priorOrderDb.status).toBe('superseded');
    expect(priorOrderDb.superseded_by_order_id).toBe(modifiedOrderId);

    // Successor order must be active with doseAmount 2000
    const [modifiedOrderDb] = await admin`
      select status, supersedes_order_id, dose_amount from ipd_medication_orders
      where id = ${modifiedOrderId}
    `;
    expect(modifiedOrderDb.status).toBe('active');
    expect(modifiedOrderDb.supersedes_order_id).toBe(scheduledCeftriaxoneId);
    expect(Number(modifiedOrderDb.dose_amount)).toBe(2000);

    // Bedside eMAR checked at 19:50 reflects the new 2000mg dose for 20:00 slot
    const eveningEmar = await getBedsideEmar({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      targetTime: new Date('2026-10-12T19:50:00+05:30'),
    });

    const eveningDue = eveningEmar.dueNow.find((d) => d.orderId === modifiedOrderId);
    expect(eveningDue).toBeDefined();
    expect(eveningDue?.scheduledTime).toEqual(new Date('2026-10-12T20:00:00+05:30'));
    expect(Number(eveningDue?.doseAmount)).toBe(2000);

    // And past administration history still clearly records the morning 1000mg dose
    const morningAdminEntry = eveningEmar.recentHistory.find(
      (a) => a.orderId === scheduledCeftriaxoneId,
    );
    expect(morningAdminEntry).toBeDefined();
    expect(morningAdminEntry?.doseGiven).toBe('1000 mg');
  });
});
