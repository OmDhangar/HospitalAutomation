import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { createDirectAdmission, transferBed } from '@/lib/services/admissions';
import { postBedDayCharges } from '@/lib/services/bed-days';
import { createChargeItem, createWard } from '@/lib/services/ipd-config';

/**
 * Bed-day charges against a real database (task T1.10): running the sweep
 * twice adds nothing, and a day is charged to the ward the patient was in
 * at the start of it.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Bed Days Test Hospital';

describe.skipIf(!enabled)('bed-day charges', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const deskId = uuid();
  let generalBed = '';
  let icuBed = '';

  const roomLines = (admissionId: string) => admin`
    select bi.service_date::text as day, bi.total_paise, ci.name
    from bill_items bi
    join bills b on b.id = bi.bill_id
    join admissions a on a.encounter_id = b.encounter_id
    join charge_items ci on ci.id = bi.charge_item_id
    where a.id = ${admissionId} and bi.item_type = 'room' and bi.voided_at is null
    order by bi.service_date`;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'bd-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Rao', 10)`;
    await admin`insert into users (id, email, password_hash, name)
      values (${deskId}, ${'desk-' + deskId + '@beddays.test'}, 'x', 'Desk')`;
    const general = await createChargeItem({
      hospitalId, input: { kind: 'room', name: 'General ward bed', sellingPricePaise: 80_000 }, actorUserId: deskId,
    });
    const icu = await createChargeItem({
      hospitalId, input: { kind: 'room', name: 'ICU bed', sellingPricePaise: 400_000 }, actorUserId: deskId,
    });
    const a = await createWard({ hospitalId, branchId, name: 'General', dailyChargeItemId: general.id, bedLabels: '1', actorUserId: deskId });
    const b = await createWard({ hospitalId, branchId, name: 'ICU', dailyChargeItemId: icu.id, bedLabels: '1', actorUserId: deskId });
    [{ id: generalBed }] = (await admin`select id from beds where ward_id = ${a.wardId}`) as unknown as { id: string }[];
    [{ id: icuBed }] = (await admin`select id from beds where ward_id = ${b.wardId}`) as unknown as { id: string }[];
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@beddays.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('charges each day once, however often the sweep runs, by the ward at the start of the day', async () => {
    const { admissionId } = await createDirectAdmission({
      hospitalId,
      branchId,
      doctorId,
      patient: { phoneE164: '+919500000001', name: 'Bed Day Patient' },
      bedId: generalBed,
      actorUserId: deskId,
    });
    // Admitted two days ago (IST morning), moved to ICU yesterday afternoon.
    const dayMs = 86_400_000;
    const admittedAt = new Date(Date.now() - 2 * dayMs);
    await admin`update admissions set admitted_at = ${admittedAt}, requested_at = ${admittedAt} where id = ${admissionId}`;
    await transferBed({ hospitalId, admissionId, bedId: icuBed, actorUserId: deskId });
    const movedAt = new Date(Date.now() - dayMs);
    // Rewrite history for the test with the guard trigger out of the way.
    await admin.begin(async (tx) => {
      await tx`alter table bed_assignments disable trigger bed_assignments_guard`;
      await tx`update bed_assignments set from_at = ${admittedAt}, to_at = ${movedAt} where admission_id = ${admissionId} and bed_id = ${generalBed}`;
      await tx`update bed_assignments set from_at = ${movedAt} where admission_id = ${admissionId} and bed_id = ${icuBed}`;
      await tx`alter table bed_assignments enable trigger bed_assignments_guard`;
    });

    const first = await postBedDayCharges(new Date(), { hospitalId });
    const second = await postBedDayCharges(new Date(), { hospitalId });
    expect(first).toBe(3);
    expect(second).toBe(0);

    const lines = await roomLines(admissionId);
    expect(lines.map((l) => l.name)).toEqual(['General ward bed', 'General ward bed', 'ICU bed']);
    expect(lines.map((l) => l.total_paise)).toEqual([80_000, 80_000, 400_000]);
  });
});
