import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The guarantees migration 0032 makes, asserted against a real Postgres: the
 * IPD tables keep tenants apart through their composite keys, a bed holds one
 * patient, records are voided rather than edited, and admissions and care
 * entries are invisible without the clinical key.
 *
 * Setup uses the admin role. Foreign keys and triggers apply to it as to
 * anyone, so the constraint cases run there too; the visibility cases use the
 * app role, which is the one row-level security binds.
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
  patientA: uuid(),
  encounterA: uuid(),
  chargeItemA: uuid(),
  roomItemA: uuid(),
  wardA: uuid(),
  wardB: uuid(),
  bed1: uuid(),
  bed2: uuid(),
  bedB: uuid(),
  admissionA: uuid(),
  assignmentA: uuid(),
  entryA: uuid(),
  billA: uuid(),
};

describe.skipIf(!enabled)('IPD schema (0032)', () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;

  const asTenant = <T>(
    hospitalId: string,
    clinical: boolean,
    fn: (tx: postgres.TransactionSql) => Promise<T>,
  ): Promise<T> =>
    app.begin(async (tx) => {
      await tx`select
        set_config('app.hospital_id', ${hospitalId}, true),
        set_config('app.read_only', 'false', true),
        set_config('app.clinical_access', ${clinical ? 'true' : 'false'}, true)`;
      return fn(tx);
    }) as Promise<T>;

  beforeAll(async () => {
    admin = postgres(adminUrl!, { max: 1 });
    app = postgres(appUrl!, { max: 2 });

    await admin`
      insert into hospitals (id, name, slug) values
        (${ids.hospitalA}, 'IPD A', ${'ipa-' + ids.hospitalA.slice(0, 8)}),
        (${ids.hospitalB}, 'IPD B', ${'ipb-' + ids.hospitalB.slice(0, 8)})`;
    await admin`
      insert into branches (id, hospital_id, name) values
        (${ids.branchA}, ${ids.hospitalA}, 'Main A'),
        (${ids.branchB}, ${ids.hospitalB}, 'Main B')`;
    await admin`
      insert into doctors (id, hospital_id, branch_id, name)
      values (${ids.doctorA}, ${ids.hospitalA}, ${ids.branchA}, 'Dr A')`;
    await admin`
      insert into patients (id, hospital_id, phone_e164, name)
      values (${ids.patientA}, ${ids.hospitalA}, '+919000000101', 'Rahul Patil')`;
    await admin`
      insert into encounters
        (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage)
      values (${ids.encounterA}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA},
              ${ids.doctorA}, 'emergency', 'ipd')`;
    await admin`
      insert into charge_items (id, hospital_id, kind, name, unit, selling_price_paise) values
        (${ids.chargeItemA}, ${ids.hospitalA}, 'consumable', 'Syringe 5 ml', 'syringe', 1500),
        (${ids.roomItemA}, ${ids.hospitalA}, 'room', 'General ward bed', 'day', 80000)`;
    await admin`
      insert into wards (id, hospital_id, branch_id, name, daily_charge_item_id) values
        (${ids.wardA}, ${ids.hospitalA}, ${ids.branchA}, 'Ward A', ${ids.roomItemA}),
        (${ids.wardB}, ${ids.hospitalB}, ${ids.branchB}, 'Ward B', null)`;
    await admin`
      insert into beds (id, hospital_id, ward_id, label) values
        (${ids.bed1}, ${ids.hospitalA}, ${ids.wardA}, '1'),
        (${ids.bed2}, ${ids.hospitalA}, ${ids.wardA}, '2'),
        (${ids.bedB}, ${ids.hospitalB}, ${ids.wardB}, '1')`;
    await admin`
      insert into admissions
        (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id,
         status, admitted_at)
      values (${ids.admissionA}, ${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA},
              ${ids.branchA}, ${ids.doctorA}, 'admitted', now())`;
    await admin`
      insert into bed_assignments (id, hospital_id, admission_id, bed_id)
      values (${ids.assignmentA}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.bed1})`;
    await admin`
      insert into care_entries
        (id, hospital_id, admission_id, encounter_id, patient_id, charge_item_id,
         description, quantity, occurred_at, client_id)
      values (${ids.entryA}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA},
              ${ids.patientA}, ${ids.chargeItemA}, 'Syringe 5 ml', 2, now(), ${uuid()})`;
    await admin`
      insert into bills (id, hospital_id, encounter_id, patient_id)
      values (${ids.billA}, ${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA})`;
  });

  afterAll(async () => {
    await admin`delete from hospitals where id in (${ids.hospitalA}, ${ids.hospitalB})`;
    await Promise.all([admin.end(), app.end()]);
  });

  describe('tenant-safe keys', () => {
    it('refuses a ward in one hospital on another hospital’s branch', async () => {
      await expect(admin`
        insert into wards (hospital_id, branch_id, name)
        values (${ids.hospitalA}, ${ids.branchB}, 'Smuggled')`).rejects.toThrow(/wards_branch_fk/);
    });

    it('refuses a bed assignment onto another hospital’s bed', async () => {
      const admission = uuid();
      const encounter = uuid();
      await admin`
        insert into encounters
          (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage)
        values (${encounter}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA},
                ${ids.doctorA}, 'emergency', 'ipd')`;
      await admin`
        insert into admissions
          (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id)
        values (${admission}, ${ids.hospitalA}, ${encounter}, ${ids.patientA},
                ${ids.branchA}, ${ids.doctorA})`;
      await expect(admin`
        insert into bed_assignments (hospital_id, admission_id, bed_id)
        values (${ids.hospitalA}, ${admission}, ${ids.bedB})`).rejects.toThrow(
        /bed_assignments_bed_fk/,
      );
    });

    it('refuses a care entry whose encounter is not the admission’s', async () => {
      const otherEncounter = uuid();
      await admin`
        insert into encounters
          (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin)
        values (${otherEncounter}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA},
                ${ids.doctorA}, 'direct')`;
      await expect(admin`
        insert into care_entries
          (hospital_id, admission_id, encounter_id, patient_id, charge_item_id,
           description, quantity, occurred_at, client_id)
        values (${ids.hospitalA}, ${ids.admissionA}, ${otherEncounter}, ${ids.patientA},
                ${ids.chargeItemA}, 'Syringe 5 ml', 1, now(), ${uuid()})`).rejects.toThrow(
        /care_entries_admission_fk/,
      );
    });
  });

  describe('beds', () => {
    it('holds one patient per bed: a second open assignment fails', async () => {
      const encounter = uuid();
      const admission = uuid();
      await admin`
        insert into encounters
          (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage)
        values (${encounter}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA},
                ${ids.doctorA}, 'emergency', 'ipd')`;
      await admin`
        insert into admissions
          (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id)
        values (${admission}, ${ids.hospitalA}, ${encounter}, ${ids.patientA},
                ${ids.branchA}, ${ids.doctorA})`;
      await expect(admin`
        insert into bed_assignments (hospital_id, admission_id, bed_id)
        values (${ids.hospitalA}, ${admission}, ${ids.bed1})`).rejects.toThrow(
        /bed_assignments_bed_occupied/,
      );
    });

    it('closes an assignment once, and never rewrites it', async () => {
      const assignment = uuid();
      const encounter = uuid();
      const admission = uuid();
      await admin`
        insert into encounters
          (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin, stage)
        values (${encounter}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA},
                ${ids.doctorA}, 'emergency', 'ipd')`;
      await admin`
        insert into admissions
          (id, hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id)
        values (${admission}, ${ids.hospitalA}, ${encounter}, ${ids.patientA},
                ${ids.branchA}, ${ids.doctorA})`;
      await admin`
        insert into bed_assignments (id, hospital_id, admission_id, bed_id)
        values (${assignment}, ${ids.hospitalA}, ${admission}, ${ids.bed2})`;
      await admin`update bed_assignments set to_at = now() where id = ${assignment}`;
      await expect(
        admin`update bed_assignments set to_at = now() + interval '1 hour' where id = ${assignment}`,
      ).rejects.toThrow(/only be closed, once/);
      await expect(
        admin`update bed_assignments set bed_id = ${ids.bed1} where id = ${assignment}`,
      ).rejects.toThrow(/only be closed, once/);
    });
  });

  describe('care entries', () => {
    it('cannot be edited, only voided one way', async () => {
      await expect(
        admin`update care_entries set quantity = 5 where id = ${ids.entryA}`,
      ).rejects.toThrow(/only be voided/);

      const entry = uuid();
      await admin`
        insert into care_entries
          (id, hospital_id, admission_id, encounter_id, patient_id, charge_item_id,
           description, quantity, occurred_at, client_id)
        values (${entry}, ${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA},
                ${ids.patientA}, ${ids.chargeItemA}, 'Syringe 5 ml', 1, now(), ${uuid()})`;
      await admin`
        update care_entries set voided_at = now(), void_reason = 'Wrong patient'
        where id = ${entry}`;
      await expect(
        admin`update care_entries set voided_at = null, void_reason = null where id = ${entry}`,
      ).rejects.toThrow(/only be voided/);
    });

    it('records a retried client id once', async () => {
      const clientId = uuid();
      const insert = () => admin`
        insert into care_entries
          (hospital_id, admission_id, encounter_id, patient_id, charge_item_id,
           description, quantity, occurred_at, client_id)
        values (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA},
                ${ids.chargeItemA}, 'Syringe 5 ml', 1, now(), ${clientId})`;
      await insert();
      await expect(insert()).rejects.toThrow(/care_entries_client_key/);
    });

    it('refuses an entry dated in the future', async () => {
      await expect(admin`
        insert into care_entries
          (hospital_id, admission_id, encounter_id, patient_id, charge_item_id,
           description, quantity, occurred_at, client_id)
        values (${ids.hospitalA}, ${ids.admissionA}, ${ids.encounterA}, ${ids.patientA},
                ${ids.chargeItemA}, 'Syringe 5 ml', 1, now() + interval '1 hour', ${uuid()})`,
      ).rejects.toThrow(/care_entries_not_future/);
    });
  });

  describe('bill lines from IPD', () => {
    const line = (extra: Record<string, unknown>) => ({
      hospital_id: ids.hospitalA,
      bill_id: ids.billA,
      description: 'Syringe 5 ml',
      quantity: 2,
      configured_unit_price_paise: 1500,
      unit_price_paise: 1500,
      subtotal_paise: 3000,
      total_paise: 3000,
      ...extra,
    });

    it('bills a care entry at most once', async () => {
      const row = line({
        item_type: 'consumable',
        charge_item_id: ids.chargeItemA,
        care_entry_id: ids.entryA,
      });
      await admin`insert into bill_items ${admin(row)}`;
      await expect(admin`insert into bill_items ${admin(row)}`).rejects.toThrow(
        /bill_items_care_entry_once/,
      );
    });

    it('bills a bed at most once per day', async () => {
      const row = line({
        item_type: 'room',
        description: 'General ward bed',
        quantity: 1,
        configured_unit_price_paise: 80000,
        unit_price_paise: 80000,
        subtotal_paise: 80000,
        total_paise: 80000,
        charge_item_id: ids.roomItemA,
        bed_assignment_id: ids.assignmentA,
        service_date: '2026-10-20',
      });
      await admin`insert into bill_items ${admin(row)}`;
      await expect(admin`insert into bill_items ${admin(row)}`).rejects.toThrow(
        /bill_items_bed_day_once/,
      );
    });

    it('refuses a line whose type and source disagree', async () => {
      await expect(
        admin`insert into bill_items ${admin(
          line({ item_type: 'room', charge_item_id: ids.roomItemA, bed_assignment_id: ids.assignmentA }),
        )}`,
      ).rejects.toThrow(/bill_items_source/);
      await expect(
        admin`insert into bill_items ${admin(line({ item_type: 'consumable' }))}`,
      ).rejects.toThrow(/bill_items_source/);
    });
  });

  describe('payers', () => {
    it('keeps one active payer per encounter, and voids rather than edits', async () => {
      const payer = uuid();
      await admin`
        insert into encounter_payers (id, hospital_id, encounter_id, patient_id, kind)
        values (${payer}, ${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA}, 'self')`;
      await expect(admin`
        insert into encounter_payers
          (hospital_id, encounter_id, patient_id, kind, payer_name)
        values (${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA}, 'insurer', 'Star Health')`,
      ).rejects.toThrow(/encounter_payers_one_active/);
      await expect(
        admin`update encounter_payers set kind = 'tpa' where id = ${payer}`,
      ).rejects.toThrow(/only be voided/);
    });

    it('requires a name for anyone but the patient', async () => {
      const encounter = uuid();
      await admin`
        insert into encounters
          (id, hospital_id, branch_id, patient_id, attending_doctor_id, origin)
        values (${encounter}, ${ids.hospitalA}, ${ids.branchA}, ${ids.patientA},
                ${ids.doctorA}, 'direct')`;
      await expect(admin`
        insert into encounter_payers (hospital_id, encounter_id, patient_id, kind)
        values (${ids.hospitalA}, ${encounter}, ${ids.patientA}, 'insurer')`).rejects.toThrow(
        /encounter_payers_named/,
      );
    });
  });

  describe('admissions', () => {
    it('keeps one live admission per encounter', async () => {
      await expect(admin`
        insert into admissions
          (hospital_id, encounter_id, patient_id, branch_id, admitting_doctor_id)
        values (${ids.hospitalA}, ${ids.encounterA}, ${ids.patientA},
                ${ids.branchA}, ${ids.doctorA})`).rejects.toThrow(
        /admissions_one_live_per_encounter/,
      );
    });

    it('needs a reason to be cancelled', async () => {
      await expect(
        admin`update admissions set status = 'cancelled', cancelled_at = now()
              where id = ${ids.admissionA}`,
      ).rejects.toThrow(/admissions_cancelled_stamped/);
    });
  });

  describe('row-level security', () => {
    it('hides admissions and care entries without the clinical key', async () => {
      const [admissions, entries] = await asTenant(ids.hospitalA, false, async (tx) => [
        await tx`select id from admissions`,
        await tx`select id from care_entries`,
      ]);
      expect(admissions).toHaveLength(0);
      expect(entries).toHaveLength(0);
    });

    it('shows them with the clinical key, to their own hospital only', async () => {
      const own = await asTenant(
        ids.hospitalA,
        true,
        (tx) => tx`select id from admissions where id = ${ids.admissionA}`,
      );
      expect(own).toHaveLength(1);
      const other = await asTenant(
        ids.hospitalB,
        true,
        (tx) => tx`select id from admissions where id = ${ids.admissionA}`,
      );
      expect(other).toHaveLength(0);
    });

    it('lets beds and wards be read without the clinical key (they are not records)', async () => {
      const beds = await asTenant(ids.hospitalA, false, (tx) => tx`select id from beds`);
      expect(beds.length).toBeGreaterThanOrEqual(2);
    });

    it('refuses a write into another hospital', async () => {
      await expect(
        asTenant(
          ids.hospitalA,
          true,
          (tx) => tx`
            insert into charge_items (hospital_id, kind, name)
            values (${ids.hospitalB}, 'consumable', 'Smuggled')`,
        ),
      ).rejects.toThrow(/row-level security/i);
    });
  });
});
