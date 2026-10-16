import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { createDirectAdmission } from '@/lib/services/admissions';
import { recordCareEntries } from '@/lib/services/care-entries';
import {
  DischargeBillError,
  discountBillLine,
  finalizeDischarge,
  getBillForPrint,
  getDischargeBillView,
  getPublicBill,
  recordIpdPayment,
  revokeBillLink,
  setApprovedAmount,
  shareBillLink,
  voidBillLine,
} from '@/lib/services/discharge-billing';
import { createChargeItem, createWard } from '@/lib/services/ipd-config';

/**
 * Discharge billing end to end against a real database (T2.1–T2.4): the
 * bill built at the bedside is reviewed, corrected with reasons, split with
 * the insurer, finalised with a gap-free number, printed with the database
 * total, and shown to the family without voided lines.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const enabled = Boolean(adminUrl && process.env.DATABASE_URL);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Discharge Billing Test Hospital';

describe.skipIf(!enabled)('discharge billing', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const deskId = uuid();
  let bedIds: string[] = [];
  let syringeId = '';
  let unpricedId = '';
  let phone = 0;

  const admit = async (bedId: string) => {
    phone += 1;
    return createDirectAdmission({
      hospitalId,
      branchId,
      doctorId,
      patient: { phoneE164: `+91940000000${phone}`, name: `Discharge Patient ${phone}` },
      bedId,
      extras: {
        payer: { kind: 'insurer', payerName: 'Star Health', policyNumber: 'SH-1', preauthAmountPaise: 100_00 },
        depositPaise: 50_00,
      },
      actorUserId: deskId,
    });
  };

  const record = (admissionId: string, itemId: string, quantity = 1) =>
    recordCareEntries({
      hospitalId,
      entries: [{ clientId: uuid(), admissionId, item: { type: 'charge', id: itemId }, quantity, occurredAt: new Date().toISOString() }],
      actorUserId: deskId,
    });

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'db-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Shah', 10)`;
    await admin`insert into users (id, email, password_hash, name)
      values (${deskId}, ${'desk-' + deskId + '@discharge.test'}, 'x', 'Desk')`;
    const room = await createChargeItem({ hospitalId, input: { kind: 'room', name: 'General ward bed', sellingPricePaise: 800_00 }, actorUserId: deskId });
    ({ id: syringeId } = await createChargeItem({ hospitalId, input: { kind: 'consumable', name: 'Syringe 5 ml', sellingPricePaise: 15_00 }, actorUserId: deskId }));
    ({ id: unpricedId } = await createChargeItem({ hospitalId, input: { kind: 'consumable', name: 'Gauze' }, actorUserId: deskId }));
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: room.id, bedLabels: '1-5', actorUserId: deskId });
    bedIds = (await admin`select id from beds where ward_id = ${wardId} order by sort_order`).map((row) => row.id as string);
  });

  afterAll(async () => {
    if (!enabled) return;
    try {
      await admin`set session_replication_role = 'replica'`;
      await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
      await admin`delete from users where email like '%@discharge.test'`;
    } finally {
      await admin`set session_replication_role = 'origin'`;
      await Promise.all([admin.end(), closeDb()]);
    }
  });

  it('refuses to finalise while an item is unpriced, then finalises gap-free', async () => {
    const { admissionId } = await admit(bedIds[0]);
    await record(admissionId, syringeId, 2);
    await record(admissionId, unpricedId);

    let view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    expect(view.flags.unpriced).toHaveLength(1);
    await expect(finalizeDischarge({ hospitalId, admissionId, actorUserId: deskId })).rejects.toBeInstanceOf(DischargeBillError);

    // The desk removes the unpriced entry (its line, if any, and the entry itself).
    await admin`update care_entries set voided_at = now(), voided_by_user_id = ${deskId}, void_reason = 'Not used'
      where admission_id = ${admissionId} and charge_item_id = ${unpricedId}`;

    view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    // 2 syringes + today's bed-day.
    expect(view.totals.totalPaise).toBe(30_00 + 800_00);
    expect(view.split.paidPaise).toBe(50_00);

    const first = await finalizeDischarge({ hospitalId, admissionId, actorUserId: deskId });
    expect(first.billNumber).toMatch(/^IPD\/\d{4}-\d{2}\/0001$/);

    const [row] = await admin`
      select a.status, e.status as encounter_status, b.total_paise, b.patient_name,
             (select count(*)::int from bed_assignments ba where ba.admission_id = a.id and ba.to_at is null) as open_beds
      from admissions a join encounters e on e.id = a.encounter_id join bills b on b.id = ${first.billId}
      where a.id = ${admissionId}`;
    expect(row).toMatchObject({ status: 'discharged', encounter_status: 'closed', total_paise: 830_00, open_beds: 0 });

    await admin`update beds set status = 'vacant' where id = ${bedIds[0]}`;
    const second = await admit(bedIds[0]);
    const { billNumber } = await finalizeDischarge({ hospitalId, admissionId: second.admissionId, actorUserId: deskId });
    expect(billNumber).toMatch(/\/0002$/);

    await expect(record(admissionId, syringeId)).resolves.toMatchObject([{ ok: false }]);
  });

  it('corrects with reasons: a discount re-posts the line, a void takes the entry with it', async () => {
    const { admissionId } = await admit(bedIds[1]);
    await record(admissionId, syringeId, 4);
    let view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    const syringeLine = view.lines.find((line) => line.description === 'Syringe 5 ml' && !line.voidedAt)!;

    await discountBillLine({ hospitalId, lineId: syringeLine.id, discountPaise: 10_00, reason: 'Staff family', actorUserId: deskId });
    view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    const discounted = view.lines.find((line) => line.description === 'Syringe 5 ml' && !line.voidedAt)!;
    expect(discounted).toMatchObject({ discountPaise: 10_00, totalPaise: 50_00, discountReason: 'Staff family' });

    await voidBillLine({ hospitalId, lineId: discounted.id, reason: 'Not given', actorUserId: deskId });
    const [entry] = await admin`select void_reason from care_entries where admission_id = ${admissionId}`;
    expect(entry.void_reason).toBe('Not given');
  });

  it('splits with the insurer, prints the database total, and shares a link the family can open', async () => {
    const { admissionId } = await admit(bedIds[2]);
    await record(admissionId, syringeId, 10);
    await setApprovedAmount({ hospitalId, admissionId, approvedAmountPaise: 500_00, actorUserId: deskId });
    await recordIpdPayment({ hospitalId, admissionId, kind: 'payment', amountPaise: 100_00, method: 'upi', actorUserId: deskId });

    const view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    expect(view.split).toMatchObject({ totalPaise: 950_00, payerSharePaise: 500_00, paidPaise: 150_00, balancePaise: 300_00 });

    const { token } = await shareBillLink({ hospitalId, admissionId, actorUserId: deskId });
    const running = await getPublicBill(token);
    expect(running.state).toBe('live');

    const { billId } = await finalizeDischarge({ hospitalId, admissionId, actorUserId: deskId });
    const printable = (await getBillForPrint({ hospitalId, billId, actorUserId: deskId }))!;
    const [db] = await admin`select total_paise from bills where id = ${billId}`;
    expect(printable.totals.totalPaise).toBe(db.total_paise);
    expect(printable.lines.reduce((sum, line) => sum + line.totalPaise, 0)).toBe(db.total_paise);

    const afterDischarge = await getPublicBill(token);
    expect(afterDischarge).toMatchObject({ state: 'live', billNumber: expect.stringMatching(/^IPD\//) });
    const [link] = await admin`select bill_link_expires_at from admissions where id = ${admissionId}`;
    expect(link.bill_link_expires_at).not.toBeNull();

    await revokeBillLink({ hospitalId, admissionId, actorUserId: deskId });
    expect((await getPublicBill(token)).state).toBe('expired');
    expect((await getPublicBill(`${hospitalId.replace(/-/g, '')}AAAAAAAAAAAAAAAAAAAAAA`)).state).toBe('missing');
  });

  it('automatically synchronizes administered eMAR medicines into bill lines with itemType medicine', async () => {
    const { admissionId } = await admit(bedIds[3]);
    const medicineId = uuid();
    await admin`
      insert into medicines (id, hospital_id, name, generic_name, unit, selling_price_paise)
      values (${medicineId}, ${hospitalId}, 'Amoxicillin 500mg Cap', 'Amoxicillin', 'capsule', 2500)
    `;

    // Prescribe and record administration
    const [order] = await admin`
      insert into ipd_medication_orders (
        id, hospital_id, admission_id, encounter_id, patient_id, prescriber_doctor_id,
        order_chain_id, medicine_id, medicine_name, dose_amount, dose_unit, route, schedule_type,
        status, signed_at, starts_at
      )
      select
        gen_random_uuid(), ${hospitalId}, ${admissionId}, a.encounter_id, a.patient_id, ${doctorId},
        gen_random_uuid(), ${medicineId}, 'Amoxicillin 500mg Cap', '500', 'mg', 'oral', 'stat',
        'active', now(), now()
      from admissions a where a.id = ${admissionId}
      returning id, order_chain_id
    `;

    await admin`
      insert into ipd_medication_administrations (
        id, hospital_id, admission_id, order_id, order_chain_id, nurse_user_id, client_id, actual_time, outcome, dose_given, route_given
      )
      values (
        gen_random_uuid(), ${hospitalId}, ${admissionId}, ${order.id}, ${order.order_chain_id}, ${deskId}, gen_random_uuid(), now(), 'administered', '500 mg', 'oral'
      )
    `;

    // Fetch view
    const view = (await getDischargeBillView({ hospitalId, admissionId }))!;
    const medLine = view.lines.find((line) => line.itemType === 'medicine' && line.description === 'Amoxicillin 500mg Cap');
    expect(medLine).toBeDefined();
    expect(medLine?.unitPricePaise).toBe(2500);
    expect(medLine?.totalPaise).toBe(2500);
    expect(view.totals.totalPaise).toBeGreaterThanOrEqual(2500);
  });
});
