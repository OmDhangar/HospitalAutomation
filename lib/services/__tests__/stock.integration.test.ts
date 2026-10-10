import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDb, withTenant } from '@/lib/db';
import { stockBalances } from '@/lib/db/schema';
import { createWard } from '@/lib/services/ipd-config';
import {
  approveCount,
  createLocation,
  createRiskClass,
  decideAdjustment,
  explainDifference,
  getCount,
  getStockOverview,
  receiveStock,
  receiveTransfer,
  requestAdjustment,
  saveCount,
  sendTransfer,
  setMedicineRiskClass,
  startCount,
  submitCount,
} from '@/lib/services/stock';

/**
 * Count-first stock against a real database (IPD sheets plan B4a, migration
 * 0046): receipts against invoices, two-sided transfers with shortfalls, blind
 * counts with the paper register's "used" figure, two-person approval, the
 * counter-who-moved-stock rule, adjustments, and the database guards that make
 * the rules hold whatever code runs.
 */
const adminUrl = process.env.DATABASE_ADMIN_URL;
const appUrl = process.env.DATABASE_URL;
const enabled = Boolean(adminUrl && appUrl);
const uuid = () => crypto.randomUUID();
const HOSPITAL_NAME = 'Stock Test Hospital';
const TODAY = '2026-10-10';

describe.skipIf(!enabled)('risk-class stock (0046)', () => {
  const admin = enabled ? postgres(adminUrl!, { max: 2 }) : (null as never);
  const app = enabled ? postgres(appUrl!, { max: 1 }) : (null as never);
  const hospitalId = uuid();
  const otherHospitalId = uuid();
  const branchId = uuid();
  const [keeper, nurseA, nurseB, doctor] = [uuid(), uuid(), uuid(), uuid()];
  const morphine = uuid();
  const paracetamol = uuid();
  let mainStore = '';
  let wardStore = '';
  let batchSoon = '';
  let batchLater = '';

  const qty = async (locationId: string, batchId: string) =>
    Number((await admin`select coalesce(sum(quantity), 0) as q from stock_balances where location_id = ${locationId} and batch_id = ${batchId}`)[0].q);

  beforeAll(async () => {
    await admin`insert into hospitals (id, name, slug) values
      (${hospitalId}, ${HOSPITAL_NAME}, ${'stk-' + hospitalId.slice(0, 12)}),
      (${otherHospitalId}, ${HOSPITAL_NAME}, ${'stk-' + otherHospitalId.slice(0, 12)})`;
    await admin`insert into branches (id, hospital_id, name) values (${branchId}, ${hospitalId}, 'Main')`;
    await admin`insert into users (id, email, password_hash, name) values
      (${keeper}, ${'k-' + keeper + '@stock.test'}, 'x', 'Store Keeper'),
      (${nurseA}, ${'a-' + nurseA + '@stock.test'}, 'x', 'Sister Anita'),
      (${nurseB}, ${'b-' + nurseB + '@stock.test'}, 'x', 'Sister Meena'),
      (${doctor}, ${'d-' + doctor + '@stock.test'}, 'x', 'Dr Pawara')`;
    await admin`insert into medicines (id, hospital_id, name, strength, form, unit) values
      (${morphine}, ${hospitalId}, 'Morphine', '10 mg/ml', 'injection', 'ampoule'),
      (${paracetamol}, ${hospitalId}, 'Paracetamol', '500 mg', 'tablet', 'tablet')`;
    const { wardId } = await createWard({ hospitalId, branchId, name: 'Ward A', dailyChargeItemId: null, bedLabels: '1-2', actorUserId: keeper });
    mainStore = await createLocation({ hospitalId, branchId, name: 'Main store', kind: 'main_store', wardId: null, actorUserId: keeper });
    wardStore = await createLocation({ hospitalId, branchId, name: 'Ward A store', kind: 'ward_store', wardId, actorUserId: keeper });
    const ndps = await createRiskClass({ hospitalId, name: 'NDPS', kind: 'ndps', countEvery: 'daily', actorUserId: keeper });
    await setMedicineRiskClass({ hospitalId, medicineId: morphine, riskClassId: ndps, actorUserId: keeper });
  });

  afterAll(async () => {
    if (!enabled) return;
    // The ledger is append-only for everyone; the test's rows go with their hospital (owner cascade).
    await admin.begin(async (tx) => {
      await tx`set local session_replication_role = replica`;
      for (const table of ['stock_ledger', 'stock_balances', 'stock_count_lines', 'stock_count_manual_use', 'stock_counts', 'stock_adjustments', 'stock_transfer_lines', 'stock_transfers', 'purchase_receipts', 'stock_batches', 'medicine_risk_classes', 'risk_classes', 'stock_locations']) {
        await tx.unsafe(`delete from ${table} where hospital_id in (select id from hospitals where name = '${HOSPITAL_NAME}')`);
      }
    });
    await admin`delete from hospitals where name = ${HOSPITAL_NAME}`;
    await admin`delete from users where email like '%@stock.test'`;
    await Promise.all([admin.end(), app.end(), closeDb()]);
  });

  it('receives risk-class stock against an invoice, once however often it is retried', async () => {
    const clientId = uuid();
    const receive = () =>
      receiveStock({
        hospitalId,
        locationId: mainStore,
        supplierName: 'Shirpur Medical Agency',
        invoiceNo: 'INV-1042',
        invoiceDate: TODAY,
        lines: [
          { medicineId: morphine, batchNo: 'mf2401', expiry: '12/2026', quantity: 10 },
          { medicineId: morphine, batchNo: 'MF2410', expiry: '06/2027', quantity: 20 },
        ],
        actorUserId: keeper,
        clientId,
        today: TODAY,
      });
    const first = await receive();
    expect((await receive()).receiptId).toBe(first.receiptId);
    [{ id: batchSoon }, { id: batchLater }] = await admin`select id from stock_batches where hospital_id = ${hospitalId} order by expiry_date`;
    expect(await qty(mainStore, batchSoon)).toBe(10);
    expect(await qty(mainStore, batchLater)).toBe(20);
  });

  it('refuses medicines outside a risk class, expired batches, and a batch number with a different expiry', async () => {
    const base = { hospitalId, locationId: mainStore, supplierName: 'Agency', invoiceNo: 'X1', invoiceDate: TODAY, actorUserId: keeper, today: TODAY };
    await expect(receiveStock({ ...base, clientId: uuid(), lines: [{ medicineId: paracetamol, batchNo: 'P1', expiry: '01/2028', quantity: 5 }] })).rejects.toThrow(/not in a risk class/);
    await expect(receiveStock({ ...base, clientId: uuid(), lines: [{ medicineId: morphine, batchNo: 'OLD1', expiry: '09/2026', quantity: 5 }] })).rejects.toThrow(/expired/);
    await expect(receiveStock({ ...base, clientId: uuid(), lines: [{ medicineId: morphine, batchNo: 'MF2401', expiry: '01/2027', quantity: 5 }] })).rejects.toThrow(/entered before with expiry 2026-12-31/);
  });

  it('keeps the balance only through the ledger: the app cannot write it, and nobody can edit a movement', async () => {
    const asApp = (statement: string) =>
      app.begin(async (tx) => {
        await tx`select set_config('app.hospital_id', ${hospitalId}, true)`;
        return tx.unsafe(statement);
      });
    await expect(asApp(`update stock_balances set quantity = 999 where location_id = '${mainStore}'`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`insert into stock_balances (hospital_id, location_id, batch_id, medicine_id, quantity) values ('${hospitalId}', '${mainStore}', '${batchSoon}', '${morphine}', 5)`)).rejects.toThrow(/permission denied/);
    await expect(asApp(`update stock_ledger set quantity = 1 where hospital_id = '${hospitalId}'`)).rejects.toThrow(/permission denied/);
    await expect(admin`update stock_ledger set quantity = 1 where hospital_id = ${hospitalId}`).rejects.toThrow(/append-only/);
  });

  it('sends stock that leaves the sender at once and arrives only when the receiver takes it in; a shortfall is kept', async () => {
    await expect(
      sendTransfer({ hospitalId, fromLocationId: mainStore, toLocationId: wardStore, lines: [{ batchId: batchSoon, quantity: 11 }], actorUserId: keeper, clientId: uuid() }),
    ).rejects.toThrow(/only 10 in Main store/);
    const { transferId } = await sendTransfer({
      hospitalId, fromLocationId: mainStore, toLocationId: wardStore, lines: [{ batchId: batchSoon, quantity: 8 }], actorUserId: keeper, clientId: uuid(),
    });
    expect(await qty(mainStore, batchSoon)).toBe(2);
    expect(await qty(wardStore, batchSoon)).toBe(0);
    const [line] = await admin`select id from stock_transfer_lines where transfer_id = ${transferId}`;
    expect(await receiveTransfer({ hospitalId, transferId, received: [{ lineId: line.id as string, quantity: 7 }], actorUserId: nurseA })).toEqual({ shortfall: 1 });
    expect(await qty(wardStore, batchSoon)).toBe(7);
    await expect(receiveTransfer({ hospitalId, transferId, received: [{ lineId: line.id as string, quantity: 7 }], actorUserId: nurseA })).rejects.toThrow(/already been taken in/);

    const overview = await getStockOverview({ hospitalId, timezone: 'Asia/Kolkata' });
    expect(overview.shortfalls).toEqual([expect.objectContaining({ missing: 1, fromName: 'Main store', toName: 'Ward A store', batchNo: 'MF2401' })]);
  });

  it('flags a count by someone who moved the stock, and refuses it once the rule is enforced', async () => {
    await expect(startCount({ hospitalId, locationId: wardStore, actorUserId: nurseA, clientId: uuid(), stage: 'enforce' })).rejects.toThrow(/Someone else must count it/);
    const flagged = await startCount({ hospitalId, locationId: wardStore, actorUserId: nurseA, clientId: uuid(), stage: 'observe' });
    expect(flagged.flagged).toBe(true);
    await expect(startCount({ hospitalId, locationId: wardStore, actorUserId: nurseB, clientId: uuid(), stage: 'observe' })).rejects.toThrow(/already open/);
    await admin`update stock_counts set status = 'cancelled' where id = ${flagged.countId}`;
  });

  it('counts blind, spreads the register’s “used” over the earliest expiry, and needs a second person and a reason to approve', async () => {
    const { countId, flagged } = await startCount({ hospitalId, locationId: wardStore, actorUserId: nurseB, clientId: uuid(), stage: 'enforce' });
    expect(flagged).toBe(false);

    const blind = await getCount(hospitalId, countId);
    expect(blind?.lines).toEqual([expect.objectContaining({ batchNo: 'MF2401', book: null, counted: null })]);
    await expect(saveCount({ hospitalId, countId, actorUserId: nurseA, counted: [{ batchId: batchSoon, quantity: 4 }], manualUse: [] })).rejects.toThrow(/Only the person who started/);
    await expect(submitCount({ hospitalId, countId, actorUserId: nurseB })).rejects.toThrow(/1 still empty/);

    // 7 on the books; the register says 2 used; 4 on the shelf: one missing.
    await saveCount({ hospitalId, countId, actorUserId: nurseB, counted: [{ batchId: batchSoon, quantity: 4 }], manualUse: [{ medicineId: morphine, used: 2 }] });
    expect(await submitCount({ hospitalId, countId, actorUserId: nurseB })).toEqual({ differences: 1 });
    const submitted = await getCount(hospitalId, countId);
    expect(submitted?.lines[0]).toMatchObject({ book: 7, usedAllocated: 2, counted: 4, variance: -1 });

    await expect(approveCount({ hospitalId, countId, actorUserId: nurseB })).rejects.toThrow(/other than the counter/);
    await expect(approveCount({ hospitalId, countId, actorUserId: doctor })).rejects.toThrow(/needs a reason/);
    await explainDifference({ hospitalId, countId, batchId: batchSoon, reasonCode: 'unknown', reasonText: '', actorUserId: nurseB });
    await approveCount({ hospitalId, countId, actorUserId: doctor });
    expect(await qty(wardStore, batchSoon)).toBe(4);

    const posted = await admin`select kind, quantity, source from stock_ledger where count_id = ${countId} order by kind`;
    expect(posted.map((p) => [p.kind, p.quantity, p.source])).toEqual([
      ['count_variance', -1, 'app'],
      ['give', -2, 'manual_register'],
    ]);
    // The approver is not the counter, in the database too; and the count is closed.
    await expect(admin`update stock_counts set approved_by_user_id = counted_by_user_id where id = ${countId}`).rejects.toThrow();
    await expect(admin`update stock_count_lines set counted_qty = 7 where count_id = ${countId}`).rejects.toThrow(/closed/);

    const overview = await getStockOverview({ hospitalId, timezone: 'Asia/Kolkata' });
    expect(overview.differences).toEqual([expect.objectContaining({ variance: -1, reasonCode: 'unknown', countedByName: 'Sister Meena', approvedByName: 'Dr Pawara' })]);
    expect(overview.stores.find((s) => s.location.id === wardStore)).toMatchObject({ countDue: false, units: 4 });
  });

  it('notices stock moved while a store was being counted', async () => {
    const { countId } = await startCount({ hospitalId, locationId: mainStore, actorUserId: nurseB, clientId: uuid(), stage: 'observe' });
    await sendTransfer({ hospitalId, fromLocationId: mainStore, toLocationId: wardStore, lines: [{ batchId: batchLater, quantity: 1 }], actorUserId: keeper, clientId: uuid() });
    await saveCount({ hospitalId, countId, actorUserId: nurseB, counted: [{ batchId: batchSoon, quantity: 2 }, { batchId: batchLater, quantity: 19 }], manualUse: [] });
    await submitCount({ hospitalId, countId, actorUserId: nurseB });
    expect((await getCount(hospitalId, countId))?.movedDuringCount).toBe(true);
  });

  it('adjusts only with a second person, and never below zero', async () => {
    await expect(
      requestAdjustment({ hospitalId, locationId: wardStore, batchId: batchSoon, direction: 'out', quantity: 9, reasonCode: 'damaged', reasonText: '', actorUserId: nurseA, clientId: uuid() }),
    ).rejects.toThrow(/Only 4/);
    const id = await requestAdjustment({ hospitalId, locationId: wardStore, batchId: batchSoon, direction: 'out', quantity: 1, reasonCode: 'damaged', reasonText: 'Ampoule broke', actorUserId: nurseA, clientId: uuid() });
    await expect(decideAdjustment({ hospitalId, adjustmentId: id, approve: true, actorUserId: nurseA })).rejects.toThrow(/other than the person who asked/);
    await decideAdjustment({ hospitalId, adjustmentId: id, approve: true, actorUserId: doctor });
    expect(await qty(wardStore, batchSoon)).toBe(3);
    const [wasted] = await admin`select kind, quantity from stock_ledger where adjustment_id = ${id}`;
    expect(wasted).toMatchObject({ kind: 'waste', quantity: -1 });
    await expect(decideAdjustment({ hospitalId, adjustmentId: id, approve: false, actorUserId: doctor })).rejects.toThrow(/already been decided/);
  });

  it('records every movement in the evidence log, and shows another hospital nothing', async () => {
    const events = await admin`select action, count(*)::int as n from acct_events where hospital_id = ${hospitalId} and object_type like 'stock%' group by action`;
    const byAction = Object.fromEntries(events.map((e) => [e.action, e.n]));
    expect(byAction['stock_movement.created']).toBeGreaterThanOrEqual(8);
    expect(byAction['stock_count.changed']).toBeGreaterThanOrEqual(2);
    expect(byAction['stock_adjustment.changed']).toBe(1);
    expect(await withTenant(otherHospitalId, (tx) => tx.select().from(stockBalances))).toEqual([]);
  });
});
