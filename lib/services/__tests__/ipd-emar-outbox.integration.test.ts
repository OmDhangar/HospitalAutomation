import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';
import {
  signRoundOrders,
} from '@/lib/services/ipd-medication-orders';
import {
  recordAdministration,
  voidAdministration,
} from '@/lib/services/ipd-emar';
import {
  claimOutboxBatch,
  recoverStuckOutboxClaims,
  processOutboxItem,
  reconcilePendingPricingItems,
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
  patientA: uuid(),
  encounterA: uuid(),
  admissionA: uuid(),
  medicinePriced: uuid(),
  medicineUnpriced: uuid(),
};

describe.skipIf(!enabled)('ipd-emar-outbox service', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Outbox Test Hospital', ${'out-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Branch A')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.nurseUserA}, ${'worker-' + ids.nurseUserA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Worker Staff')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr Worker', ${ids.nurseUserA})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000501',
      name: 'Ramesh Gupta',
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
        (${ids.medicinePriced}, ${ids.hospitalA}, 'Paracetamol 650mg Tab', 'Paracetamol', 'tablet', 300),
        (${ids.medicineUnpriced}, ${ids.hospitalA}, 'Unpriced Experimental Tab', 'TestDrug', 'tablet', null)
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

  it('claims pending outbox rows with lease locking and updates status to processing', async () => {
    // Prescribe and administer priced medicine
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Prescribe priced paracetamol',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicinePriced,
            medicineName: 'Paracetamol 650mg Tab',
            doseAmount: '650',
            doseUnit: 'mg',
            route: 'oral',
            scheduleType: 'stat',
            scheduleTimes: ['now'],
            startsAt: new Date(),
          },
        },
      ],
    });

    await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: signRes.signedOrderIds[0],
      input: {
        clientId: uuid(),
        actualTime: new Date(),
        doseAmount: '650',
        doseGiven: '650 mg',
        routeGiven: 'oral',
      },
      actorUserId: ids.nurseUserA,
    });

    // Claim the batch
    const claimed = await claimOutboxBatch({
      hospitalId: ids.hospitalA,
      limit: 5,
    });

    expect(claimed.length).toBeGreaterThanOrEqual(1);
    const item = claimed[0];
    expect(item.status).toBe('processing');
    expect(item.claimedAt).not.toBeNull();
  });

  it('recovers stuck outbox claims older than 5 minutes', async () => {
    // Manually age the claimed item to 10 minutes ago
    await admin`
      update ipd_emar_integration_outbox
      set claimed_at = now() - interval '10 minutes'
      where hospital_id = ${ids.hospitalA} and status = 'processing'
    `;

    const recoveredCount = await recoverStuckOutboxClaims({
      hospitalId: ids.hospitalA,
      maxClaimAgeMs: 5 * 60 * 1000,
    });

    expect(recoveredCount).toBeGreaterThanOrEqual(1);

    const [recoveredItem] = await admin`
      select status, claimed_at from ipd_emar_integration_outbox
      where hospital_id = ${ids.hospitalA} and status = 'pending'
      order by created_at desc limit 1
    `;
    expect(recoveredItem.status).toBe('pending');
    expect(recoveredItem.claimed_at).toBeNull();
  });

  it('processes priced medicine outbox item and posts billing care entry line', async () => {
    // Claim batch
    const batch = await claimOutboxBatch({
      hospitalId: ids.hospitalA,
      limit: 1,
    });
    expect(batch.length).toBe(1);

    const item = batch[0];
    const res = await processOutboxItem({
      item,
      actorUserId: ids.nurseUserA,
    });

    expect(res.outcome).toBe('processed');

    // Outbox item is now processed
    const [dbItem] = await admin`
      select status, processed_at from ipd_emar_integration_outbox
      where id = ${item.id}
    `;
    expect(dbItem.status).toBe('processed');
    expect(dbItem.processed_at).not.toBeNull();

    // Verify care_entry was created and linked to administration
    const [adminRow] = await admin`
      select care_entry_id from ipd_medication_administrations
      where id = ${item.administrationId}
    `;
    expect(adminRow.care_entry_id).not.toBeNull();

    // Verify bill line exists
    const [billItem] = await admin`
      select unit_price_paise, quantity from bill_items
      where care_entry_id = ${adminRow.care_entry_id}
    `;
    expect(billItem).toBeDefined();
    expect(billItem.unit_price_paise).toBe(300);
  });

  it('moves unpriced medicine outbox item to pending_pricing and reconciles after pricing', async () => {
    // Prescribe and administer unpriced medicine
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Prescribe unpriced medicine',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicineUnpriced,
            medicineName: 'Unpriced Experimental Tab',
            doseAmount: '1',
            doseUnit: 'tab',
            route: 'oral',
            scheduleType: 'stat',
            scheduleTimes: ['now'],
            startsAt: new Date(),
          },
        },
      ],
    });

    await recordAdministration({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      orderId: signRes.signedOrderIds[0],
      input: {
        clientId: uuid(),
        actualTime: new Date(),
        doseAmount: '1',
        doseGiven: '1 tab',
        routeGiven: 'oral',
      },
      actorUserId: ids.nurseUserA,
    });

    // Claim and process
    const batch = await claimOutboxBatch({
      hospitalId: ids.hospitalA,
      limit: 1,
    });
    expect(batch.length).toBe(1);

    const unpricedItem = batch[0];
    const res = await processOutboxItem({
      item: unpricedItem,
      actorUserId: ids.nurseUserA,
    });

    expect(res.outcome).toBe('pending_pricing');

    const [dbItem] = await admin`
      select status, attempts from ipd_emar_integration_outbox
      where id = ${unpricedItem.id}
    `;
    expect(dbItem.status).toBe('pending_pricing');
    expect(dbItem.attempts).toBe(0); // Should not count as a failed attempt

    // Now update price in catalog
    await admin`
      update medicines
      set selling_price_paise = 500
      where id = ${ids.medicineUnpriced}
    `;

    // Reconcile
    const reconciledCount = await reconcilePendingPricingItems({
      hospitalId: ids.hospitalA,
      medicineId: ids.medicineUnpriced,
    });
    expect(reconciledCount).toBe(1);

    const [reconciledDbItem] = await admin`
      select status from ipd_emar_integration_outbox
      where id = ${unpricedItem.id}
    `;
    expect(reconciledDbItem.status).toBe('pending');
  });

  it('handles void event by striking through the linked care entry line', async () => {
    // 1. Process the reconciled item so it becomes processed and billed
    await processPendingOutboxBatch({ hospitalId: ids.hospitalA });

    // 2. Void the administration
    const [adminRow] = await admin`
      select id from ipd_medication_administrations
      where admission_id = ${ids.admissionA} and voided_at is null
      order by created_at desc
      limit 1
    `;
    await voidAdministration({
      hospitalId: ids.hospitalA,
      administrationId: adminRow.id,
      reason: 'Entered for wrong patient in error',
      actorUserId: ids.nurseUserA,
    });

    // 3. Process the void outbox event
    const summary = await processPendingOutboxBatch({ hospitalId: ids.hospitalA });
    expect(summary.processed).toBeGreaterThanOrEqual(1);

    // Verify bill line is voided
    const [careEntry] = await admin`
      select id from care_entries where medicine_id = ${ids.medicineUnpriced}
    `;
    const [billLine] = await admin`
      select voided_at, void_reason from bill_items where care_entry_id = ${careEntry.id}
    `;
    expect(billLine.voided_at).not.toBeNull();
  });
});
