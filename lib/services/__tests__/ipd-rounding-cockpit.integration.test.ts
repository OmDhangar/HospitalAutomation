import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';
import {
  getRoundingCockpitData,
  recordAllergyAssessment,
  saveRoundDraft,
} from '@/lib/services/ipd-rounding-cockpit';
import { signRoundOrders } from '@/lib/services/ipd-medication-orders';

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
  medicinePantoprazole: uuid(),
  medicineParacetamol: uuid(),
};

describe.skipIf(!enabled)('ipd-rounding-cockpit service', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Cockpit Test Hospital', ${'cockpit-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Main Branch')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.nurseUserA}, ${'doc-' + ids.nurseUserA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Dr Sanjeev')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr Sanjeev', ${ids.nurseUserA})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000701',
      name: 'Kamla Nehru',
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
        (${ids.medicinePantoprazole}, ${ids.hospitalA}, 'Pantoprazole 40mg Inj', 'Pantoprazole', 'vial', 8500),
        (${ids.medicineParacetamol}, ${ids.hospitalA}, 'Paracetamol 650mg Tab', 'Paracetamol', 'tablet', 300)
    `;
  });

  afterAll(async () => {
    try {
      await admin`set session_replication_role = 'replica'`;
      await admin`delete from ipd_allergy_assessments where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_medication_order_actions where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_medication_orders where hospital_id = ${ids.hospitalA}`;
      await admin`delete from ipd_clinical_rounds where hospital_id = ${ids.hospitalA}`;
      await admin`delete from hospitals where id = ${ids.hospitalA}`;
    } finally {
      await admin`set session_replication_role = 'origin'`;
      await admin.end();
    }
  });

  it('loads cockpit data with default unreviewed allergy status and stale vitals indicators', async () => {
    const data = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.nurseUserA,
    });

    expect(data.admission.patientName).toBe('Kamla Nehru');
    expect(data.allergyAssessment.status).toBe('unreviewed');
    expect(data.vitalsFreshness.isStale).toBe(true);
    expect(data.activeOrders).toEqual([]);
    expect(data.draftRound).toBeNull();
  });

  it('records and updates allergy assessment preserving revision history', async () => {
    // 1. Initial NKDA assessment
    const res1 = await recordAllergyAssessment({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      status: 'nkda',
      actorUserId: ids.nurseUserA,
      doctorId: ids.doctorA,
    });
    expect(res1.status).toBe('nkda');

    const data1 = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.nurseUserA,
    });
    expect(data1.allergyAssessment.status).toBe('nkda');

    // 2. Updated to documented drug allergy (Penicillin)
    const res2 = await recordAllergyAssessment({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      status: 'allergies_documented',
      allergens: ['Penicillin', 'Sulfa'],
      actorUserId: ids.nurseUserA,
      doctorId: ids.doctorA,
    });
    expect(res2.status).toBe('allergies_documented');

    // Verify revision history in database
    const history = await admin`
      select status, is_current, allergens from ipd_allergy_assessments
      where hospital_id = ${ids.hospitalA} and admission_id = ${ids.admissionA}
      order by recorded_at asc
    `;
    expect(history).toHaveLength(2);
    expect(history[0].status).toBe('nkda');
    expect(history[0].is_current).toBe(false);
    expect(history[1].status).toBe('allergies_documented');
    expect(history[1].is_current).toBe(true);
    expect(history[1].allergens).toEqual([{ substance: 'Penicillin' }, { substance: 'Sulfa' }]);
  });

  it('persists round notes as draft without altering active medication orders', async () => {
    const draftRes = await saveRoundDraft({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Patient resting comfortably. Vitals stable.',
    });

    expect(draftRes.roundId).toBeDefined();

    const data = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.nurseUserA,
    });

    expect(data.draftRound?.notes).toBe('Patient resting comfortably. Vitals stable.');
    expect(data.activeOrders).toHaveLength(0); // eMAR / active orders remain zero
  });

  it('signs round orders and reflects them in cockpit active orders list', async () => {
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.nurseUserA,
      notes: 'Finalized morning round. Starting IV Pantoprazole.',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicinePantoprazole,
            medicineName: 'Pantoprazole 40mg Inj',
            doseAmount: '40',
            doseUnit: 'mg',
            route: 'iv_push',
            scheduleType: 'scheduled',
            frequencyCode: 'OD',
            scheduleTimes: ['08:00'],
            startsAt: new Date(),
          },
        },
      ],
    });

    expect(signRes.signedOrderIds).toHaveLength(1);

    const data = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.nurseUserA,
    });

    expect(data.activeOrders).toHaveLength(1);
    expect(data.activeOrders[0].medicineName).toBe('Pantoprazole 40mg Inj');
  });
});
