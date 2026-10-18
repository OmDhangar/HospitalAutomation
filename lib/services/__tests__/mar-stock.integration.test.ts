import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb } from '@/lib/db';
import { parseOrder, parseWaste } from '@/lib/domain/mar';
import { serviceDateIn } from '@/lib/domain/time';
import { hashPassword } from '@/lib/security/password';
import { createDirectAdmission } from '@/lib/services/admissions';
import { createWard } from '@/lib/services/ipd-config';
import {
  createOrder,
  decideWitnessRequest,
  getDoseRegister,
  listDeviceWitnessRequests,
  listMyWitnessRequests,
  listStockToResolve,
  listWastes,
  postShortByHand,
  recordGive,
  recordWaste,
  strikeOutDose,
  strikeOutWaste,
  witnessOnDevice,
  type Actor,
} from '@/lib/services/mar';
import {
  approveCount,
  createLocation,
  createRiskClass,
  explainDifference,
  getReconciliation,
  getVarianceRecurrence,
  receiveStock,
  saveCount,
  setMedicineRiskClass,
  startCount,
  submitCount,
} from '@/lib/services/stock';
import { createWardDevice, enrolWardDevice, resolveWardDevice, setOwnPin, type WardDevice } from '@/lib/services/staff-access';

/**
 * The treatment card posting to the stock ledger, against a real database
 * (IPD sheets plan B4b, migration 0050): a risk-class give comes off the
 * ward's store first-expiry-first, once per retry, never from an expired
 * batch; a store that cannot cover it leaves the dose saved and short, to be
 * taken off by hand; a struck-out dose is put back; waste comes off only once
 * a second person witnesses it; counts stop asking for the register's "used"
 * figure; the reconciliation, the patient-wise register and D13; the guards.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'MAR Stock Test Hospital';
const TZ = 'Asia/Kolkata';
const PASSWORD = 'correct horse battery';

describe.skipIf(!enabled)('treatment card → stock ledger (0050)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const hospitalId = uuid();
  const branchId = uuid();
  const doctorId = uuid();
  const [ownerUser, doctorUser, nurseA, nurseB] = [uuid(), uuid(), uuid(), uuid()];
  const [morphine, ceftriaxone] = [uuid(), uuid()];
  let admissionId = '';
  let wardId = '';
  let wardStore = '';
  let mainStore = '';
  let device: WardDevice;
  let morphineOrder = '';
  const today = serviceDateIn(TZ, new Date());

  const personal = (userId: string): Actor => ({ userId, channel: 'personal', wardDeviceId: null });
  const tablet = (userId: string): Actor => ({ userId, channel: 'ward_device', wardDeviceId: device.id });

  const give = (extra: Partial<Parameters<typeof recordGive>[0]> = {}) =>
    recordGive({
      hospitalId,
      orderId: morphineOrder,
      occurredAt: new Date(),
      dose: '4 mg',
      quantity: 1,
      lateReason: null,
      witnessUserId: nurseB,
      clientId: uuid(),
      actor: personal(nurseA),
      stage: 'observe',
      stock: { on: true },
      ...extra,
    });

  const balances = async (locationId: string) =>
    Object.fromEntries(
      (
        await admin`select b.batch_no, s.quantity from stock_balances s join stock_batches b on b.id = s.batch_id
          where s.location_id = ${locationId} and s.medicine_id = ${morphine} order by b.batch_no`
      ).map((r) => [r.batch_no as string, Number(r.quantity)]),
    );
  const ledgerFor = async (prefix: string) =>
    admin`select kind, source, quantity, reference_key from stock_ledger where reference_key like ${prefix + '%'} order by reference_key`;

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values (${hospitalId}, ${HOSPITAL_NAME}, ${'ms-' + hospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    const hash = await hashPassword(PASSWORD);
    await admin`insert into users (id, email, password_hash, name, last_login_at) values
      (${ownerUser}, ${'o-' + ownerUser + '@ms.test'}, ${hash}, 'Owner', now()),
      (${doctorUser}, ${'d-' + doctorUser + '@ms.test'}, ${hash}, 'Dr Kale', now()),
      (${nurseA}, ${'a-' + nurseA + '@ms.test'}, ${hash}, 'Sister Asha', now()),
      (${nurseB}, ${'b-' + nurseB + '@ms.test'}, ${hash}, 'Sister Bina', now())`;
    await admin`insert into staff_memberships (user_id, hospital_id, role) values
      (${ownerUser}, ${hospitalId}, 'owner'), (${doctorUser}, ${hospitalId}, 'doctor'),
      (${nurseA}, ${hospitalId}, 'nurse'), (${nurseB}, ${hospitalId}, 'nurse')`;
    await admin`insert into doctors (id, hospital_id, branch_id, name, user_id, default_consult_minutes)
      values (${doctorId}, ${hospitalId}, ${branchId}, 'Dr Kale', ${doctorUser}, 10)`;
    await admin`insert into medicines (id, hospital_id, name, strength, form, unit, selling_price_paise) values
      (${morphine}, ${hospitalId}, 'Morphine', '10 mg/ml', 'injection', 'ampoule', 5000),
      (${ceftriaxone}, ${hospitalId}, 'Ceftriaxone', '1 g', 'injection', 'vial', 9000)`;
    const ndps = await createRiskClass({ hospitalId, name: 'NDPS', kind: 'ndps', countEvery: 'daily', actorUserId: ownerUser });
    await setMedicineRiskClass({ hospitalId, medicineId: morphine, riskClassId: ndps, actorUserId: ownerUser });

    ({ wardId } = await createWard({ hospitalId, branchId, name: 'Ward S', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: ownerUser }));
    const [bed] = await admin`select id from beds where ward_id = ${wardId} order by sort_order limit 1`;
    ({ admissionId } = await createDirectAdmission({
      hospitalId, branchId, doctorId,
      patient: { phoneE164: '+919300000088', name: 'Vitthal More' },
      bedId: bed.id as string,
      actorUserId: ownerUser,
    }));
    wardStore = await createLocation({ hospitalId, branchId, name: 'Ward S store', kind: 'ward_store', wardId, actorUserId: ownerUser });
    mainStore = await createLocation({ hospitalId, branchId, name: 'Main store', kind: 'main_store', wardId: null, actorUserId: ownerUser });
    // Two batches on the ward: the one expiring first is used first.
    await receiveStock({
      hospitalId, locationId: wardStore, supplierName: 'Sai Pharma', invoiceNo: 'INV-1', invoiceDate: today, actorUserId: ownerUser, clientId: uuid(), today,
      lines: [
        { medicineId: morphine, batchNo: 'MSOON', expiry: '2027-03-31', quantity: 2 },
        { medicineId: morphine, batchNo: 'MLATE', expiry: '2028-03-31', quantity: 5 },
      ],
    });
    // An expired batch on the shelf (as the books would hold it before someone wastes it): never given from.
    const [old] = await admin`insert into stock_batches (hospital_id, medicine_id, batch_no, expiry_date)
      values (${hospitalId}, ${morphine}, 'MOLD', '2026-01-31') returning id`;
    await admin`insert into stock_ledger (hospital_id, location_id, medicine_id, batch_id, kind, quantity, reference_key)
      values (${hospitalId}, ${wardStore}, ${morphine}, ${old.id}, 'adjust', 3, ${'test:' + uuid()})`;

    morphineOrder = (
      await createOrder({
        hospitalId, admissionId,
        input: parseOrder({ kind: 'medicine', medicineId: morphine, dose: '4 mg', route: 'iv', frequency: 'SOS' }),
        orderingDoctorId: doctorId, clientId: uuid(), actor: personal(doctorUser), mayTranscribe: false,
      })
    ).orderId;

    const created = await createWardDevice({ hospitalId, branchId, name: 'Ward S tablet', wardIds: [], actorUserId: ownerUser });
    device = (await resolveWardDevice((await enrolWardDevice(created.code))!.cookieValue))!;
    await setOwnPin({ hospitalId, userId: nurseB, pin: '5937', password: PASSWORD });
  });

  afterAll(async () => {
    if (!enabled) return;
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of [
        'witness_requests', 'mar_wastes', 'presence_proofs', 'mar_administrations', 'treatment_orders', 'stock_ledger', 'stock_balances',
        'stock_count_lines', 'stock_count_manual_use', 'stock_counts', 'purchase_receipts', 'stock_batches', 'stock_locations',
        'medicine_risk_classes', 'risk_classes',
      ]) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@ms.test'`;
    await Promise.all([admin.end(), closeDb()]);
  });

  it('takes a give off the ward store, earliest unexpired batch first, once however often it is retried', async () => {
    const clientId = uuid();
    const first = await give({ clientId });
    expect(first.stock).toBe('posted');
    const again = await give({ clientId });
    expect(again).toMatchObject({ marId: first.marId, repeat: true, stock: 'posted' });
    expect(await ledgerFor(`mar:${first.marId}:`)).toEqual([{ kind: 'give', source: 'mar', quantity: -1, reference_key: `mar:${first.marId}:1` }]);
    expect(await balances(wardStore)).toEqual({ MLATE: 5, MOLD: 3, MSOON: 1 });

    // Three more: the last of MSOON, then MLATE — never the expired MOLD.
    const three = await give({ quantity: 3 });
    expect((await ledgerFor(`mar:${three.marId}:`)).map((r) => r.quantity)).toEqual([-1, -2]);
    expect(await balances(wardStore)).toEqual({ MLATE: 3, MOLD: 3, MSOON: 0 });
    const [row] = await admin`select stock_status, stock_location_id from mar_administrations where id = ${three.marId}`;
    expect(row).toMatchObject({ stock_status: 'posted', stock_location_id: wardStore });
  });

  it('takes nothing off when stock is not in use, the medicine is not risk-class, or nothing is given', async () => {
    const off = await give({ stock: { on: false } });
    const zero = await give({ quantity: 0 });
    const cefOrder = await createOrder({
      hospitalId, admissionId,
      input: parseOrder({ kind: 'medicine', medicineId: ceftriaxone, dose: '1 g', route: 'iv', frequency: 'BD' }),
      orderingDoctorId: doctorId, clientId: uuid(), actor: personal(doctorUser), mayTranscribe: false,
    });
    const cef = await give({ orderId: cefOrder.orderId, witnessUserId: null });
    for (const outcome of [off, zero, cef]) expect(outcome.stock).toBeNull();
    expect(await balances(wardStore)).toEqual({ MLATE: 3, MOLD: 3, MSOON: 0 });
  });

  it('saves a dose the store cannot cover as short, and takes it off another store by hand', async () => {
    const big = await give({ quantity: 4 });
    expect(big.stock).toBe('short');
    expect(await ledgerFor(`mar:${big.marId}:`)).toEqual([]);
    expect(await balances(wardStore)).toEqual({ MLATE: 3, MOLD: 3, MSOON: 0 });
    const open = await listStockToResolve({ hospitalId });
    expect(open).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'dose', id: big.marId, status: 'short', units: 4, patientName: 'Vitthal More' })]));

    await expect(postShortByHand({ hospitalId, kind: 'dose', id: big.marId, locationId: mainStore, actorUserId: ownerUser })).rejects.toThrow(/does not hold enough/);
    await receiveStock({
      hospitalId, locationId: mainStore, supplierName: 'Sai Pharma', invoiceNo: 'INV-2', invoiceDate: today, actorUserId: ownerUser, clientId: uuid(), today,
      lines: [{ medicineId: morphine, batchNo: 'MMAIN', expiry: '2028-06-30', quantity: 10 }],
    });
    await postShortByHand({ hospitalId, kind: 'dose', id: big.marId, locationId: mainStore, actorUserId: ownerUser });
    expect(await balances(mainStore)).toEqual({ MMAIN: 6 });
    const [row] = await admin`select stock_status, stock_location_id from mar_administrations where id = ${big.marId}`;
    expect(row).toMatchObject({ stock_status: 'posted', stock_location_id: mainStore });
    await expect(postShortByHand({ hospitalId, kind: 'dose', id: big.marId, locationId: mainStore, actorUserId: ownerUser })).rejects.toThrow(/nothing waiting/);
    expect((await listStockToResolve({ hospitalId })).some((i) => i.id === big.marId)).toBe(false);
  });

  it('puts a struck-out dose back on the shelf, once', async () => {
    const dose = await give({ quantity: 2 });
    expect(await balances(wardStore)).toEqual({ MLATE: 1, MOLD: 3, MSOON: 0 });
    await strikeOutDose({ hospitalId, marId: dose.marId, actorUserId: nurseA, isOwner: false, reason: 'Wrong patient chart' });
    await strikeOutDose({ hospitalId, marId: dose.marId, actorUserId: nurseA, isOwner: false, reason: 'Wrong patient chart' });
    expect(await balances(wardStore)).toEqual({ MLATE: 3, MOLD: 3, MSOON: 0 });
    const reversals = await admin`select kind, quantity from stock_ledger where reference_key like 'rev:%' and location_id = ${wardStore}`;
    expect(reversals).toEqual([{ kind: 'reversal', quantity: 2 }]);
    const [row] = await admin`select stock_status from mar_administrations where id = ${dose.marId}`;
    expect(row.stock_status).toBe('reversed');
  });

  it('takes waste off stock only once a second person witnesses it', async () => {
    await expect(
      recordWaste({ hospitalId, orderId: morphineOrder, marId: null, occurredAt: new Date(), waste: parseWaste({ reason: 'broken', units: '1' }), locationId: null, witnessUserId: null, clientId: uuid(), actor: personal(nurseA), stockOn: true }),
    ).rejects.toThrow(/Choose who will witness/);
    const broken = await recordWaste({
      hospitalId, orderId: morphineOrder, marId: null, occurredAt: new Date(),
      waste: parseWaste({ reason: 'broken', units: '1' }), locationId: null, witnessUserId: nurseB, clientId: uuid(), actor: personal(nurseA), stockOn: true,
    });
    expect(await balances(wardStore)).toEqual({ MLATE: 3, MOLD: 3, MSOON: 0 });
    const [request] = (await listMyWitnessRequests({ hospitalId, userId: nurseB })).filter((r) => r.action === 'waste');
    expect(request).toMatchObject({ action: 'waste', dose: 'Waste: 1 unit', patientName: 'Vitthal More' });
    await expect(decideWitnessRequest({ hospitalId, requestId: request.id, userId: nurseA, approve: true, channel: 'personal', deviceId: null, sessionId: null })).rejects.toThrow(/not found/);
    await decideWitnessRequest({ hospitalId, requestId: request.id, userId: nurseB, approve: true, channel: 'personal', deviceId: null, sessionId: null });
    expect(await balances(wardStore)).toEqual({ MLATE: 2, MOLD: 3, MSOON: 0 });
    expect(await ledgerFor(`waste:${broken.wasteId}:`)).toEqual([{ kind: 'waste', source: 'mar', quantity: -1, reference_key: `waste:${broken.wasteId}:1` }]);

    // The rest of an opened ampoule takes nothing more off; witnessed on the tablet with the witness's PIN.
    const given = await give({ quantity: 1, actor: tablet(nurseA), witnessUserId: null });
    expect(() => parseWaste({ reason: 'remainder', units: '1', amount: '6 mg' })).toThrow(/already off stock/);
    expect(() => parseWaste({ reason: 'remainder', units: '0' })).toThrow(/how much/);
    const rest = await recordWaste({
      hospitalId, orderId: morphineOrder, marId: given.marId, occurredAt: new Date(),
      waste: parseWaste({ reason: 'remainder', units: '0', amount: '6 mg (0.6 ml)' }), locationId: null, witnessUserId: null, clientId: uuid(), actor: tablet(nurseA), stockOn: true,
    });
    const onTablet = (await listDeviceWitnessRequests({ hospitalId, deviceId: device.id })).find((r) => r.action === 'waste');
    expect(onTablet?.dose).toBe('Waste: 6 mg (0.6 ml)');
    await witnessOnDevice({ hospitalId, requestId: onTablet!.id, device, witnessUserId: nurseB, pin: '5937', sessionId: null });
    const [restRow] = await admin`select witness_status, witnessed_by_user_id, stock_status from mar_wastes where id = ${rest.wasteId}`;
    expect(restRow).toMatchObject({ witness_status: 'witnessed', witnessed_by_user_id: nurseB, stock_status: null });
    expect(await balances(wardStore)).toEqual({ MLATE: 1, MOLD: 3, MSOON: 0 }); // the give only

    // Struck out after it was witnessed: back on the shelf.
    await strikeOutWaste({ hospitalId, wasteId: broken.wasteId, actorUserId: nurseA, isOwner: false, reason: 'Found intact' });
    expect(await balances(wardStore)).toEqual({ MLATE: 2, MOLD: 3, MSOON: 0 });
    const wastes = await listWastes({ hospitalId, admissionId, from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 3_600_000) });
    expect(wastes.map((w) => [w.reason, w.voided, w.stockStatus])).toEqual([
      ['broken', true, 'reversed'],
      ['remainder', false, null],
    ]);
    await expect(
      recordWaste({ hospitalId, orderId: (await admin`select id from treatment_orders where medicine_id = ${ceftriaxone} limit 1`)[0].id as string, marId: null, occurredAt: new Date(), waste: parseWaste({ reason: 'broken', units: '1' }), locationId: null, witnessUserId: nurseB, clientId: uuid(), actor: personal(nurseA), stockOn: true }),
    ).rejects.toThrow(/risk-class medicines only/);
  });

  it('counts a store whose doses post from the card without the register’s "used" figure', async () => {
    // Nurse A gave from this store, but giving is not issuing: she may still count it, even in enforce.
    const { countId } = await startCount({ hospitalId, locationId: wardStore, actorUserId: nurseA, clientId: uuid(), stage: 'enforce' });
    const batches = await admin`select b.id, b.batch_no from stock_balances s join stock_batches b on b.id = s.batch_id where s.location_id = ${wardStore} and s.quantity > 0`;
    const counted = batches.map((b) => ({ batchId: b.id as string, quantity: b.batch_no === 'MLATE' ? 1 : 3 }));
    // A "used" figure typed anyway is ignored: the books already hold every give.
    await saveCount({ hospitalId, countId, actorUserId: nurseA, counted, manualUse: [{ medicineId: morphine, used: 5 }], marPosts: true });
    const { differences } = await submitCount({ hospitalId, countId, actorUserId: nurseA, marPosts: true });
    expect(differences).toBe(1); // MLATE: 2 on the books, 1 on the shelf
    const lines = await admin`select l.variance, l.used_allocated, b.batch_no from stock_count_lines l join stock_batches b on b.id = l.batch_id where l.count_id = ${countId} order by b.batch_no`;
    expect(lines.map((l) => [l.batch_no, l.variance, l.used_allocated])).toEqual([['MLATE', -1, 0], ['MOLD', 0, 0]]);
    const late = batches.find((b) => b.batch_no === 'MLATE')!;
    await explainDifference({ hospitalId, countId, batchId: late.id as string, reasonCode: 'unknown', reasonText: '', actorUserId: nurseA });
    await approveCount({ hospitalId, countId, actorUserId: ownerUser });

    // A second count with a difference on the same store within 7 days: D13 lists the store and the counter.
    const second = await startCount({ hospitalId, locationId: wardStore, actorUserId: nurseA, clientId: uuid(), stage: 'observe' });
    await saveCount({ hospitalId, countId: second.countId, actorUserId: nurseA, counted: batches.map((b) => ({ batchId: b.id as string, quantity: b.batch_no === 'MLATE' ? 0 : 3 })), manualUse: [], marPosts: true });
    await submitCount({ hospitalId, countId: second.countId, actorUserId: nurseA, marPosts: true });
    await explainDifference({ hospitalId, countId: second.countId, batchId: late.id as string, reasonCode: 'broken', reasonText: '', actorUserId: nurseA });
    await approveCount({ hospitalId, countId: second.countId, actorUserId: ownerUser });
    const flags = await getVarianceRecurrence({ hospitalId, timezone: TZ });
    expect(flags).toEqual(expect.arrayContaining([
      expect.objectContaining({ on: 'location', label: 'Ward S store', counts: 2 }),
      expect.objectContaining({ on: 'person', label: 'Sister Asha', counts: 2 }),
    ]));
  });

  it('reconciles each store from the ledger: opening + movements = closing = what the books hold', async () => {
    const recon = await getReconciliation({ hospitalId, locationId: wardStore, from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });
    const late = recon.rows.find((r) => r.batchNo === 'MLATE')!;
    expect(late).toMatchObject({ opening: 0, received: 5, givenMar: 5, givenRegister: 0, wasted: 1, putBack: 3, countDifference: -2, closing: 0 });
    const soon = recon.rows.find((r) => r.batchNo === 'MSOON')!;
    expect(soon).toMatchObject({ received: 2, givenMar: 2, closing: 0 });
    for (const row of recon.rows) {
      const [book] = await admin`select coalesce(sum(quantity), 0)::int as q from stock_balances where location_id = ${wardStore} and batch_id = (select id from stock_batches where hospital_id = ${hospitalId} and batch_no = ${row.batchNo})`;
      expect(row.closing).toBe(book.q);
    }
    expect(recon.counts).toHaveLength(2);
  });

  it('lists every give and waste of a medicine patient-wise, with batch, store and witness', async () => {
    const rows = await getDoseRegister({ hospitalId, medicineId: morphine, from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 60_000) });
    const posted = rows.find((r) => r.kind === 'give' && r.units === 3)!;
    expect(posted).toMatchObject({ patientName: 'Vitthal More', storeName: 'Ward S store', batches: 'MSOON ×1, MLATE ×2', stockStatus: 'posted', recordedBy: 'Sister Asha' });
    expect(rows.find((r) => r.kind === 'give' && r.units === 4)).toMatchObject({ storeName: 'Main store', batches: 'MMAIN ×4' });
    expect(rows.find((r) => r.kind === 'give' && r.voided)).toMatchObject({ stockStatus: 'reversed', note: 'Wrong patient chart' });
    expect(rows.filter((r) => r.kind === 'waste').map((r) => [r.units, r.amount, r.witnessedBy])).toEqual([
      [1, null, 'Sister Bina'],
      [0, '6 mg (0.6 ml)', 'Sister Bina'],
    ]);
  });

  it('holds the stock state of doses and wastes in the database', async () => {
    const [posted] = await admin`select id from mar_administrations where stock_status = 'posted' and hospital_id = ${hospitalId} limit 1`;
    await expect(admin`update mar_administrations set stock_status = 'short' where id = ${posted.id}`).rejects.toThrow(/only moves forward/);
    await expect(admin`update mar_administrations set stock_location_id = ${mainStore} where id = ${posted.id}`).rejects.toThrow(/set when it is taken off/);
    const [waste] = await admin`select id from mar_wastes where hospital_id = ${hospitalId} limit 1`;
    await expect(admin`update mar_wastes set units = 5 where id = ${waste.id}`).rejects.toThrow(/cannot be edited/);
    await expect(admin`delete from mar_wastes where id = ${waste.id}`).rejects.toThrow(/never deleted/);
    const [batch] = await admin`select id from stock_batches where hospital_id = ${hospitalId} and batch_no = 'MLATE'`;
    await expect(
      admin`insert into stock_ledger (hospital_id, location_id, medicine_id, batch_id, kind, quantity, count_id)
        values (${hospitalId}, ${wardStore}, ${morphine}, ${batch.id}, 'reversal', 1, (select id from stock_counts where hospital_id = ${hospitalId} limit 1))`,
    ).rejects.toThrow(/stock_ledger_direction_v2/);
    await expect(
      admin`insert into stock_ledger (hospital_id, location_id, medicine_id, batch_id, kind, quantity, source, count_id)
        values (${hospitalId}, ${wardStore}, ${morphine}, ${batch.id}, 'adjust', 1, 'mar', (select id from stock_counts where hospital_id = ${hospitalId} limit 1))`,
    ).rejects.toThrow(/stock_ledger_mar_reference/);
    const [dose] = await admin`select id, occurred_at from mar_administrations where hospital_id = ${hospitalId} limit 1`;
    await expect(
      admin`insert into witness_requests (hospital_id, admission_id, action, mar_id, mar_occurred_at, waste_id, actor_user_id, method, witness_user_id, expires_at)
        values (${hospitalId}, ${admissionId}, 'waste', ${dose.id}, ${dose.occurred_at}, ${waste.id}, ${nurseA}, 'approval', ${nurseB}, now() + interval '10 minutes')`,
    ).rejects.toThrow(/witness_requests_subject/);
    // The evidence log has the stock movements of the card, with their reference.
    const [evidence] = await admin`select count(*)::int as n from acct_events where hospital_id = ${hospitalId} and object_type = 'stock_movement' and payload->>'source' = 'mar'`;
    expect(evidence.n).toBeGreaterThan(5);
  });
});
