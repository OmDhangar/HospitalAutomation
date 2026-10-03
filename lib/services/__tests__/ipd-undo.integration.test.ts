import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { assignBed, cancelAdmission, createDirectAdmission } from '@/lib/services/admissions';
import { recordCareEntries, voidCareEntry } from '@/lib/services/care-entries';
import {
  discountBillLine,
  finalizeDischarge,
  getDischargeBillView,
  recordIpdPayment,
  voidBillLine,
} from '@/lib/services/discharge-billing';
import { addBeds, createChargeItem, createWard, setChargeItemPrices } from '@/lib/services/ipd-config';
import {
  UndoError,
  reopenDischarge,
  undoAddBeds,
  undoAssignBed,
  undoCancelAdmission,
  undoCreateWard,
  undoDirectAdmission,
  undoDiscount,
  undoPayment,
  undoPriceBatch,
  undoVoidBillLine,
  undoVoidCareEntry,
} from '@/lib/services/ipd-undo';

/**
 * Undo against a real database: each action can be taken back cleanly while
 * nothing has been built on it, and is refused once something has.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Undo Test Hospital';

describe.skipIf(!enabled)('undo', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const deskId = uuid();
  let wardId = '';
  let syringeId = '';
  let phone = 0;
  const base = () => ({ hospitalId, actorUserId: deskId });

  const freeBed = async () => {
    const [bed] = await admin`
      select b.id from beds b where b.ward_id = ${wardId}
        and not exists (select 1 from bed_assignments ba where ba.bed_id = b.id and ba.to_at is null)
      order by b.sort_order limit 1`;
    return bed.id as string;
  };
  const patient = () => {
    phone += 1;
    return { phoneE164: `+91910000000${phone}`, name: `Undo Patient ${phone}` };
  };
  const record = (admissionId: string, quantity = 1) =>
    recordCareEntries({
      hospitalId,
      entries: [{ clientId: uuid(), admissionId, item: { type: 'charge', id: syringeId }, quantity, occurredAt: new Date().toISOString() }],
      actorUserId: deskId,
    });

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'un-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Undo', 10)`;
    await admin`insert into users (id, email, password_hash, name) values (${deskId}, ${'desk-' + deskId + '@undo.test'}, 'x', 'Desk')`;
    ({ id: syringeId } = await createChargeItem({
      hospitalId, input: { kind: 'consumable', name: 'Syringe 5 ml', sellingPricePaise: 15_00 }, actorUserId: deskId,
    }));
    ({ wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '6', actorUserId: deskId }));
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@undo.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('makes "6" six beds, "2" two more after them, and takes the two back', async () => {
    const before = (await admin`select label from beds where ward_id = ${wardId} order by sort_order`).map((b) => b.label);
    expect(before).toEqual(['1', '2', '3', '4', '5', '6']);
    const { bedIds } = await addBeds({ hospitalId, wardId, labels: '2', actorUserId: deskId });
    const labels = (await admin`select label from beds where id in ${admin(bedIds)} order by sort_order`).map((b) => b.label);
    expect(labels).toEqual(['7', '8']);
    await undoAddBeds({ ...base(), bedIds });
    const [{ n }] = await admin`select count(*)::int as n from beds where ward_id = ${wardId}`;
    expect(n).toBe(6);
  });

  it('removes a ward made by mistake, but not one a patient has used', async () => {
    const extra = await createWard({ hospitalId, branchId, name: 'Oops ward', dailyChargeItemId: null, bedLabels: '2', actorUserId: deskId });
    await undoCreateWard({ ...base(), wardId: extra.wardId });
    expect(await admin`select id from wards where id = ${extra.wardId}`).toHaveLength(0);

    const used = await createWard({ hospitalId, branchId, name: 'Used ward', dailyChargeItemId: null, bedLabels: '1', actorUserId: deskId });
    await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), bedId: used.bedIds[0], actorUserId: deskId });
    await expect(undoCreateWard({ ...base(), wardId: used.wardId })).rejects.toBeInstanceOf(UndoError);
  });

  it('restores a mistaken price and re-bills lines charged at it', async () => {
    const { admissionId } = await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), bedId: await freeBed(), actorUserId: deskId });
    const { batch } = await setChargeItemPrices({ hospitalId, edits: [{ id: syringeId, sellingPricePaise: 1500_00 }], actorUserId: deskId });
    await record(admissionId, 2);
    const lineTotal = async () =>
      (await admin`select total_paise from bill_items where charge_item_id = ${syringeId} and voided_at is null
        and care_entry_id in (select id from care_entries where admission_id = ${admissionId})`).map((r) => r.total_paise);
    expect(await lineTotal()).toEqual([3000_00]);

    const result = await undoPriceBatch({ ...base(), batch });
    expect(result.restored).toBe(1);
    const [item] = await admin`select selling_price_paise from charge_items where id = ${syringeId}`;
    expect(item.selling_price_paise).toBe(15_00);
    expect(await lineTotal()).toEqual([30_00]);
    await expect(undoPriceBatch({ ...base(), batch })).rejects.toBeInstanceOf(UndoError);
  });

  it('takes back a bed assignment with its deposit, but not once something is recorded', async () => {
    const { admissionId } = await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), actorUserId: deskId });
    const { depositId } = await assignBed({ hospitalId, admissionId, bedId: await freeBed(), extras: { depositPaise: 2000_00 }, actorUserId: deskId });
    await undoAssignBed({ ...base(), admissionId, depositId });
    const [row] = await admin`
      select a.status, a.admitted_at, (select count(*)::int from bed_assignments where admission_id = a.id) as beds,
             (select voided_at from patient_payments where id = ${depositId}) as deposit_voided
      from admissions a where a.id = ${admissionId}`;
    expect(row).toMatchObject({ status: 'awaiting_bed', admitted_at: null, beds: 0 });
    expect(row.deposit_voided).not.toBeNull();

    await assignBed({ hospitalId, admissionId, bedId: await freeBed(), actorUserId: deskId });
    await record(admissionId);
    await expect(undoAssignBed({ ...base(), admissionId, depositId: null })).rejects.toBeInstanceOf(UndoError);
  });

  it('takes back a cancellation and an emergency admission', async () => {
    const waiting = await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), actorUserId: deskId });
    await cancelAdmission({ hospitalId, admissionId: waiting.admissionId, reason: 'Wrong patient', actorUserId: deskId });
    await undoCancelAdmission({ ...base(), admissionId: waiting.admissionId });
    const [restored] = await admin`select status from admissions where id = ${waiting.admissionId}`;
    expect(restored.status).toBe('awaiting_bed');

    const mistake = await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), bedId: await freeBed(), actorUserId: deskId });
    await undoDirectAdmission({ ...base(), admissionId: mistake.admissionId, depositId: null });
    const [gone] = await admin`
      select a.status, e.status as encounter_status,
             (select count(*)::int from bed_assignments where admission_id = a.id) as beds
      from admissions a join encounters e on e.id = a.encounter_id where a.id = ${mistake.admissionId}`;
    expect(gone).toMatchObject({ status: 'cancelled', encounter_status: 'cancelled', beds: 0 });
  });

  it('brings back a removed entry, line, discount and payment', async () => {
    const { admissionId } = await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), bedId: await freeBed(), actorUserId: deskId });
    const [entry] = await record(admissionId, 3);
    const entryId = (entry as { entryId: string }).entryId;
    await voidCareEntry({ hospitalId, entryId, reason: 'Wrong bed', actorUserId: deskId });
    await undoVoidCareEntry({ ...base(), entryId });

    let view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    let line = view.lines.find((l) => l.description === 'Syringe 5 ml' && !l.voidedAt)!;
    expect(line.totalPaise).toBe(45_00);

    await voidBillLine({ hospitalId, lineId: line.id, reason: 'Not given', actorUserId: deskId });
    await undoVoidBillLine({ ...base(), lineId: line.id });
    view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    line = view.lines.find((l) => l.description === 'Syringe 5 ml' && !l.voidedAt)!;
    expect(line.totalPaise).toBe(45_00);

    const { lineId } = await discountBillLine({ hospitalId, lineId: line.id, discountPaise: 15_00, reason: 'Goodwill', actorUserId: deskId });
    await undoDiscount({ ...base(), lineId });
    view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    expect(view.lines.filter((l) => l.description === 'Syringe 5 ml' && !l.voidedAt).map((l) => l.totalPaise)).toEqual([45_00]);

    const { paymentId } = await recordIpdPayment({ hospitalId, admissionId, kind: 'payment', amountPaise: 999_00, method: 'cash', actorUserId: deskId });
    await undoPayment({ ...base(), paymentId });
    view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    expect(view.split.paidPaise).toBe(0);
  });

  it('reopens a final bill: the number stays used, the lines move to a new draft', async () => {
    const { admissionId } = await createDirectAdmission({ hospitalId, branchId, doctorId, patient: patient(), bedId: await freeBed(), actorUserId: deskId });
    await record(admissionId, 2);
    const first = await finalizeDischarge({ hospitalId, admissionId, actorUserId: deskId });
    await reopenDischarge({ ...base(), admissionId, reason: 'Missed an item' });

    const [old] = await admin`select status, bill_number from bills where id = ${first.billId}`;
    expect(old).toMatchObject({ status: 'cancelled', bill_number: first.billNumber });
    const view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    expect(view.admission.status).not.toBe('discharged');
    expect(view.bill?.status).toBe('draft');
    expect(view.totals.totalPaise).toBe(30_00);

    await record(admissionId, 1);
    const second = await finalizeDischarge({ hospitalId, admissionId, actorUserId: deskId });
    expect(second.billNumber).not.toBe(first.billNumber);
    const [final] = await admin`select total_paise from bills where id = ${second.billId}`;
    expect(final.total_paise).toBe(45_00);
  });
});
