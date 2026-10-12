import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToString } from 'react-dom/server';

vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/navigation')>();
  return {
    ...actual,
    useRouter: () => ({
      push: vi.fn(),
      refresh: vi.fn(),
      replace: vi.fn(),
    }),
  };
});
import { insertFixturePatient } from '@/lib/test/patient-fixture';
import {
  getRoundingCockpitData,
  recordAllergyAssessment,
  saveRoundDraft,
} from '@/lib/services/ipd-rounding-cockpit';
import { signRoundOrders } from '@/lib/services/ipd-medication-orders';
import { RoundingCockpit } from '@/components/ipd/rounding/rounding-cockpit';

const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

const ids = {
  hospitalA: uuid(),
  branchA: uuid(),
  doctorA: uuid(),
  docUserA: uuid(),
  patientA: uuid(),
  encounterA: uuid(),
  admissionA: uuid(),
  medicineCeftriaxone: uuid(),
  medicinePantoprazole: uuid(),
};

describe.skipIf(!enabled)('Doctor Rounding Cockpit Integration', () => {
  let admin: postgres.Sql;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'Cockpit E2E Hospital', ${'e2e-' + ids.hospitalA.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Main Branch')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.docUserA}, ${'doc-e2e-' + ids.docUserA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Dr. Ramesh')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr. Ramesh', ${ids.docUserA})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000888',
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
        (${ids.medicineCeftriaxone}, ${ids.hospitalA}, 'Ceftriaxone 1g Injection', 'Ceftriaxone', 'vial', 12000),
        (${ids.medicinePantoprazole}, ${ids.hospitalA}, 'Pantoprazole 40mg Tab', 'Pantoprazole', 'tab', 800)
    `;
  });

  afterAll(async () => {
    if (admin) {
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
    }
  });

  it('loads cockpit data and renders the complete unified UI workspace', async () => {
    const cockpitData = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.docUserA,
    });

    expect(cockpitData.admission.patientName).toBe('Sunita Devi');
    expect(cockpitData.allergyAssessment.status).toBe('unreviewed');
    expect(cockpitData.activeOrders).toHaveLength(0);

    // Verify SSR rendering of RoundingCockpit orchestrator
    const html = renderToString(
      <RoundingCockpit
        initialData={cockpitData}
        doctorId={ids.doctorA}
      />,
    );

    expect(html).toContain('No active medication orders');
    expect(html).toContain('Allergy Assessment Required');
    expect(html).toContain('Inpatient Prescribing');
    expect(html).toContain('Clinical Round Notes');
  });

  it('updates allergy status and displays documented allergens', async () => {
    await recordAllergyAssessment({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      status: 'allergies_documented',
      allergens: [{ substance: 'Penicillin', reaction: 'Urticaria', severity: 'moderate' }],
      actorUserId: ids.docUserA,
    });

    const cockpitData = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.docUserA,
    });

    expect(cockpitData.allergyAssessment.status).toBe('allergies_documented');
    expect(cockpitData.allergyAssessment.allergens).toHaveLength(1);
    expect(cockpitData.allergyAssessment.allergens[0].substance).toBe('Penicillin');

    const html = renderToString(
      <RoundingCockpit
        initialData={cockpitData}
        doctorId={ids.doctorA}
      />,
    );

    expect(html).toContain('Documented Drug Allergies');
    expect(html).toContain('Penicillin');
  });

  it('saves round notes draft without prematurely affecting active orders', async () => {
    const draftRes = await saveRoundDraft({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.docUserA,
      notes: 'Morning round: Patient afebrile, wound clean.',
    });

    expect(draftRes.roundId).toBeDefined();

    const cockpitData = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.docUserA,
    });

    expect(cockpitData.draftRound?.notes).toContain('Morning round: Patient afebrile');
    expect(cockpitData.activeOrders).toHaveLength(0);
  });

  it('signs round orders and immediately makes them active in the cockpit', async () => {
    const signRes = await signRoundOrders({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      doctorId: ids.doctorA,
      authorUserId: ids.docUserA,
      notes: 'Finalized morning round: initiate IV Ceftriaxone.',
      resolutions: [
        {
          type: 'new',
          order: {
            medicineId: ids.medicineCeftriaxone,
            medicineName: 'Ceftriaxone 1g Injection',
            doseAmount: '1',
            doseUnit: 'g',
            route: 'iv_push',
            scheduleType: 'scheduled',
            frequencyCode: 'BD',
            scheduleTimes: ['08:00', '20:00'],
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 86400000 * 3),
            durationDays: 3,
          },
        },
      ],
    });

    expect(signRes.roundId).toBeDefined();
    expect(signRes.signedOrderIds).toHaveLength(1);

    const cockpitData = await getRoundingCockpitData({
      hospitalId: ids.hospitalA,
      admissionId: ids.admissionA,
      userId: ids.docUserA,
    });

    expect(cockpitData.activeOrders).toHaveLength(1);
    expect(cockpitData.activeOrders[0].medicineName).toBe('Ceftriaxone 1g Injection');
    expect(cockpitData.draftRound).toBeNull(); // Draft was signed!

    const html = renderToString(
      <RoundingCockpit
        initialData={cockpitData}
        doctorId={ids.doctorA}
      />,
    );

    expect(html).toContain('Ceftriaxone 1g Injection');
    expect(html).toContain('BD');
    expect(html).toContain('Continue');
  });
});
