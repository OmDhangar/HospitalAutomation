import fs from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertFixturePatient } from '@/lib/test/patient-fixture';

/**
 * Guarantees established by migration 0047 (SPEC-IPD-EMAR-001):
 * - Composite foreign keys bind rounds, orders, and administrations strictly to their admission and tenant
 * - Direct modification of signed clinical medication orders is blocked by database triggers
 * - Order audit actions are strictly append-only
 * - Medication administrations cannot be updated or deleted, only voided
 * - Approved order sets and items are immutable
 * - Multi-tenant RLS enforces complete isolation and fails closed
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);

const uuid = () => crypto.randomUUID();

const ids = {
  hospitalA: uuid(),
  hospitalB: uuid(),
  branchA: uuid(),
  branchB: uuid(),
  doctorA: uuid(),
  doctorB: uuid(),
  userA: uuid(),
  userB: uuid(),
  patientA: uuid(),
  patientB: uuid(),
  encounterA: uuid(),
  encounterB: uuid(),
  admissionA: uuid(),
  admissionB: uuid(),
  medicineA: uuid(),
  medicineB: uuid(),
};

describe.skipIf(!enabled)('IPD eMAR & Rounding Foundation (0047)', () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;

  const asTenant = <T>(
    hospitalId: string,
    clinical: boolean,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
    readOnly = false,
  ): Promise<T> =>
    app.begin(async (tx) => {
      await tx`select
        set_config('app.hospital_id', ${hospitalId}, true),
        set_config('app.read_only', ${readOnly ? 'true' : 'false'}, true),
        set_config('app.clinical_access', ${clinical ? 'true' : 'false'}, true)`;
      return fn(tx);
    }) as Promise<T>;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    app = postgres(appUrl!, { max: 2 });

    // Apply migration 0047 if tables do not exist yet in test database
    const [tableCheck] = await admin`
      select to_regclass('ipd_clinical_rounds') as round_tbl,
             to_regclass('ipd_medication_orders') as order_tbl
    `;
    if (!tableCheck.round_tbl || !tableCheck.order_tbl) {
      const sqlPath = path.resolve(process.cwd(), 'drizzle/0047_ipd_emar_foundation.sql');
      const rawSql = fs.readFileSync(sqlPath, 'utf8');
      await admin.unsafe(rawSql);
    }

    // Seed test tenants and base clinical infrastructure
    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'eMAR Hospital A', ${'emar-a-' + ids.hospitalA.slice(0, 8)}),
        (${ids.hospitalB}, 'eMAR Hospital B', ${'emar-b-' + ids.hospitalB.slice(0, 8)})
    `;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Branch A'),
        (${ids.branchB}, ${ids.hospitalB}, 'Branch B')
    `;
    await admin`
      insert into users (id, email, password_hash, name) values
        (${ids.userA}, ${'doc-a-' + ids.userA.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Dr A'),
        (${ids.userB}, ${'doc-b-' + ids.userB.slice(0, 8) + '@example.com'}, 'dummy_hash', 'Dr B')
    `;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name, user_id) values
        (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr A', ${ids.userA}),
        (${ids.doctorB}, ${ids.hospitalB}, ${ids.branchB}, 'Dr B', ${ids.userB})
    `;
    await insertFixturePatient(admin, {
      id: ids.patientA,
      hospitalId: ids.hospitalA,
      phoneE164: '+919000000201',
      name: 'Aditi Sharma',
    });
    await insertFixturePatient(admin, {
      id: ids.patientB,
      hospitalId: ids.hospitalB,
      phoneE164: '+919000000202',
      name: 'Rohan Mehra',
    });
    await admin`
      insert into encounters
        (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage)
      values
        (${ids.encounterA}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA}, ${ids.doctorA}, 'emergency', 'ipd'),
        (${ids.encounterB}, ${ids.hospitalB}, ${ids.branchB}, ${ids.patientB}, ${ids.doctorB}, 'emergency', 'ipd')
    `;
    await admin`
      insert into admissions
        (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id, status, admitted_at)
      values
        (${ids.admissionA}, ${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA}, ${ids.branchA}, ${ids.doctorA}, 'admitted', now()),
        (${ids.admissionB}, ${ids.hospitalB}, ${ids.encounterB}, ${ids.patientB}, ${ids.branchB}, ${ids.doctorB}, 'admitted', now())
    `;
    await admin`
      insert into medicines (id, hospital_id, name, generic_name, unit) values
        (${ids.medicineA}, ${ids.hospitalA}, 'Paracetamol 500mg Tab', 'Paracetamol', 'tablet'),
        (${ids.medicineB}, ${ids.hospitalB}, 'Amoxicillin 250mg Cap', 'Amoxicillin', 'capsule')
    `;
  });

  afterAll(async () => {
    try {
      await admin`set session_replication_role = 'replica'`;
      await admin`delete from ipd_emar_integration_outbox where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_medication_administrations where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_medication_order_actions where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_medication_orders where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_allergy_assessments where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_order_set_items where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_order_sets where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from ipd_clinical_rounds where hospital_id in (${ids.hospitalA}, ${ids.hospitalB})`;
      await admin`delete from hospitals where id in (${ids.hospitalA}, ${ids.hospitalB})`;
    } finally {
      await admin`set session_replication_role = 'origin'`;
      await Promise.all([admin.end(), app.end()]);
    }
  });

  describe('composite foreign key and tenant integrity', () => {
    it('refuses clinical rounds with mismatched encounter or hospital', async () => {
      // Smuggle encounter from hospital B into hospital A
      await expect(admin`
        insert into ipd_clinical_rounds
          (hospital_id, admission_id, encounter_id, patient_id, doctor_id, author_user_id, evaluation_notes, status)
        values
          (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterB}, ${ids.patientA}, ${ids.doctorA}, ${ids.userA}, 'Routine morning round', 'draft')
      `).rejects.toThrow(/ipd_clinical_rounds_tenant_fk/);
    });

    it('refuses medication orders with mismatched encounter, patient, or medicine', async () => {
      // Smuggle patient from hospital B into hospital A admission order
      await expect(admin`
        insert into ipd_medication_orders
          (hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status)
        values
          (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientB}, ${uuid()}, ${ids.medicineA},
           'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'draft')
      `).rejects.toThrow(/ipd_med_orders_tenant_fk/);

      // Smuggle medicine from hospital B into hospital A order
      await expect(admin`
        insert into ipd_medication_orders
          (hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status)
        values
          (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${uuid()}, ${ids.medicineB},
           'Amoxicillin 250mg', 250, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'draft')
      `).rejects.toThrow(/ipd_med_orders_medicine_fk/);
    });

    it('refuses administrations linking an order belonging to another admission', async () => {
      const orderId = uuid();
      const chainId = uuid();
      await admin`
        insert into ipd_medication_orders
          (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status, signed_at)
        values
          (${orderId}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${chainId}, ${ids.medicineA},
           'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'active', now())
      `;

      // Administration claims admission B while pointing to order from admission A
      await expect(admin`
        insert into ipd_medication_administrations
          (hospital_id, order_id, order_chain_id, admission_id, client_id,
           dose_amount_numeric, dose_given, route_given, actual_time, outcome, nurse_user_id)
        values
          (${ids.hospitalA}, ${orderId}, ${chainId}, ${ids.admissionB}, ${uuid()},
           500, '500 mg', 'oral', now(), 'administered', ${ids.userA})
      `).rejects.toThrow(/ipd_med_admin_order_admission_fk/);
    });
  });

  describe('signed order immutability', () => {
    it('blocks direct update of clinical instruction columns on signed orders', async () => {
      const orderId = uuid();
      const chainId = uuid();
      await admin`
        insert into ipd_medication_orders
          (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status, signed_at)
        values
          (${orderId}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${chainId}, ${ids.medicineA},
           'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'active', now())
      `;

      // Direct mutation of dose_amount
      await expect(admin`
        update ipd_medication_orders
        set dose_amount = 1000
        where id = ${orderId}
      `).rejects.toThrow(/Signed clinical medication instructions are immutable/);

      // Direct mutation of route
      await expect(admin`
        update ipd_medication_orders
        set route = 'iv_push'
        where id = ${orderId}
      `).rejects.toThrow(/Signed clinical medication instructions are immutable/);

      // Lifecycle status transitions are allowed
      const updated = await admin`
        update ipd_medication_orders
        set status = 'on_hold', updated_at = now()
        where id = ${orderId}
        returning status
      `;
      expect(updated[0].status).toBe('on_hold');
    });
  });

  describe('append-only order actions audit', () => {
    it('allows insert but forbids update and delete', async () => {
      const orderId = uuid();
      const chainId = uuid();
      await admin`
        insert into ipd_medication_orders
          (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status, signed_at)
        values
          (${orderId}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${chainId}, ${ids.medicineA},
           'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'active', now())
      `;

      const actionId = uuid();
      await admin`
        insert into ipd_medication_order_actions
          (id, hospital_id, order_id, action, actor_user_id, doctor_id)
        values
          (${actionId}, ${ids.hospitalA}, ${orderId}, 'sign', ${ids.userA}, ${ids.doctorA})
      `;

      // UPDATE must fail
      await expect(admin`
        update ipd_medication_order_actions
        set action = 'hold'
        where id = ${actionId}
      `).rejects.toThrow(/Clinical action audit history is strictly append-only/);

      // DELETE must fail
      await expect(admin`
        delete from ipd_medication_order_actions
        where id = ${actionId}
      `).rejects.toThrow(/Clinical action audit history is strictly append-only/);
    });
  });

  describe('administration void-only enforcement', () => {
    it('forbids delete and modifying clinical fields, but allows voiding', async () => {
      const orderId = uuid();
      const chainId = uuid();
      const adminId = uuid();
      await admin`
        insert into ipd_medication_orders
          (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status, signed_at)
        values
          (${orderId}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${chainId}, ${ids.medicineA},
           'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'active', now())
      `;

      await admin`
        insert into ipd_medication_administrations
          (id, hospital_id, order_id, order_chain_id, admission_id, client_id,
           dose_amount_numeric, dose_given, route_given, actual_time, outcome, nurse_user_id)
        values
          (${adminId}, ${ids.hospitalA}, ${orderId}, ${chainId}, ${ids.admissionA}, ${uuid()},
           500, '500 mg', 'oral', now(), 'administered', ${ids.userA})
      `;

      // DELETE must fail
      await expect(admin`
        delete from ipd_medication_administrations
        where id = ${adminId}
      `).rejects.toThrow(/Administration records cannot be deleted/);

      // Modifying clinical execution details must fail
      await expect(admin`
        update ipd_medication_administrations
        set dose_given = '1000 mg'
        where id = ${adminId}
      `).rejects.toThrow(/Clinical administration details are immutable/);

      // Voiding with reason must succeed
      const voided = await admin`
        update ipd_medication_administrations
        set voided_at = now(), void_reason = 'Wrong dose entered',
            voided_by_user_id = ${ids.userA}
        where id = ${adminId}
        returning voided_at, void_reason
      `;
      expect(voided[0].void_reason).toBe('Wrong dose entered');
      expect(voided[0].voided_at).not.toBeNull();
    });
  });

  describe('order set template immutability', () => {
    it('allows editing draft order set items but locks approved order sets', async () => {
      const setId = uuid();
      const itemId = uuid();

      // Create draft set and add item
      await admin`
        insert into ipd_order_sets
          (id, hospital_id, code, name, category, status, version)
        values
          (${setId}, ${ids.hospitalA}, 'POA', 'Post-Op Analgesia', 'surgery', 'draft', 1)
      `;

      await admin`
        insert into ipd_order_set_items
          (id, hospital_id, order_set_id, medicine_id, default_dose_amount, default_dose_unit,
           default_route, default_schedule_type, default_frequency_code, sort_order)
        values
          (${itemId}, ${ids.hospitalA}, ${setId}, ${ids.medicineA}, 500, 'mg',
           'oral', 'scheduled', 'TDS', 1)
      `;

      // Approve the order set
      await admin`
        update ipd_order_sets
        set status = 'approved', approved_at = now(), approved_by_doctor_id = ${ids.doctorA}
        where id = ${setId}
      `;

      // Modifying approved order set name must fail
      await expect(admin`
        update ipd_order_sets
        set name = 'Modified Post-Op Analgesia'
        where id = ${setId}
      `).rejects.toThrow(/Approved order sets are immutable/);

      // Modifying items on approved order set must fail
      await expect(admin`
        update ipd_order_set_items
        set default_dose_amount = 1000
        where id = ${itemId}
      `).rejects.toThrow(/Items in an approved order set are immutable/);

      // Adding new items to approved set must fail
      await expect(admin`
        insert into ipd_order_set_items
          (hospital_id, order_set_id, medicine_id, default_dose_amount, default_dose_unit,
           default_route, default_schedule_type, default_frequency_code, sort_order)
        values
          (${ids.hospitalA}, ${setId}, ${ids.medicineA}, 1000, 'mg',
           'oral', 'scheduled', 'BD', 2)
      `).rejects.toThrow(/Items in an approved order set are immutable/);
    });
  });

  describe('row-level security and tenant isolation', () => {
    it('isolates medication orders between Hospital A and Hospital B', async () => {
      const orderA = uuid();
      const orderB = uuid();

      await admin`
        insert into ipd_medication_orders
          (id, hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
           medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
           starts_at, prescriber_doctor_id, status, signed_at)
        values
          (${orderA}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${uuid()}, ${ids.medicineA},
           'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorA}, 'active', now()),
          (${orderB}, ${ids.hospitalB}, ${ids.admissionB}, ${ids.encounterB}, ${ids.patientB}, ${uuid()}, ${ids.medicineB},
           'Amoxicillin 250mg', 250, 'mg', 'oral', 'scheduled', 'TDS',
           now(), ${ids.doctorB}, 'active', now())
      `;

      const rowsA = await asTenant(ids.hospitalA, true, (tx) => tx`
        select id from ipd_medication_orders where id in (${orderA}, ${orderB})
      `);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0].id).toBe(orderA);

      const rowsB = await asTenant(ids.hospitalB, true, (tx) => tx`
        select id from ipd_medication_orders where id in (${orderA}, ${orderB})
      `);
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].id).toBe(orderB);
    });

    it('fails closed when hospital_id is not set', async () => {
      const rows = await app.begin(async (tx) => {
        await tx`select set_config('app.hospital_id', '', true)`;
        return tx`select id from ipd_medication_orders`;
      });
      expect(rows).toHaveLength(0);
    });

    it('refuses writes when app.read_only is true', async () => {
      await expect(
        asTenant(
          ids.hospitalA,
          true,
          (tx) => tx`
            insert into ipd_medication_orders
              (hospital_id, admission_id, encounter_id, patient_id, order_chain_id, medicine_id,
               medicine_name, dose_amount, dose_unit, route, schedule_type, frequency_code,
               starts_at, prescriber_doctor_id, status)
            values
              (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA}, ${uuid()}, ${ids.medicineA},
               'Paracetamol 500mg', 500, 'mg', 'oral', 'scheduled', 'TDS',
               now(), ${ids.doctorA}, 'draft')
          `,
          true, // readOnly = true
        ),
      ).rejects.toThrow(/read_only_write/);
    });

    it('hides clinical medication orders when clinical_access is false', async () => {
      const rows = await asTenant(ids.hospitalA, false, (tx) => tx`
        select id from ipd_medication_orders
      `);
      expect(rows).toHaveLength(0);
    });
  });
});
