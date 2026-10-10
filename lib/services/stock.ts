import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  auditLogs,
  branches,
  medicineRiskClasses,
  medicines,
  purchaseReceipts,
  riskClasses,
  stockAdjustments,
  stockBalances,
  stockBatches,
  stockCountLines,
  stockCountManualUse,
  stockCounts,
  stockLedger,
  stockLocations,
  stockTransferLines,
  stockTransfers,
  users,
  wards,
} from '@/lib/db/schema';
import {
  ADJUST_REASONS,
  StockError,
  adjustmentQuantity,
  countDue,
  countOutcome,
  expiryStatus,
  fefo,
  isVarianceReason,
  parseBatchNo,
  parseExpiry,
  type AdjustReason,
  type LocationKind,
  type RiskKind,
  type VarianceReason,
} from '@/lib/domain/stock';
import { serviceDateIn } from '@/lib/domain/time';
import type { ModuleStage } from '@/lib/modules/registry';

/**
 * Count-first stock for risk-class medicines (IPD sheets plan B4a, §7.3;
 * migration 0046). Each operation is one transaction. The database keeps the
 * balances from the ledger and refuses a movement that would take a balance
 * below zero, an approver who is the counter, a requester who approves their
 * own adjustment, and any edit of a movement — so these rules hold whatever
 * calls this file. Everything is captured by the evidence log.
 */

export { StockError };

/* -------------------------------------------------------------- helpers */

async function audit(tx: Tx, args: { hospitalId: string; actorUserId: string; action: string; objectType: string; objectId: string; metadata?: Record<string, unknown> }) {
  await tx.insert(auditLogs).values(args);
}

/** A movement refused by stock_balances' CHECK: the place does not hold that much (any more). */
const isShortfall = (err: unknown): boolean => {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23514' && e.constraint_name === 'stock_balances_quantity_check') return true;
  }
  return false;
};

const twoPeopleViolation = (err: unknown): boolean => {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23514' && (e.constraint_name === 'stock_counts_two_people' || e.constraint_name === 'stock_adjustments_two_people')) return true;
  }
  return false;
};

async function inTx<T>(hospitalId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  try {
    return await withTenant(hospitalId, fn);
  } catch (err) {
    if (isShortfall(err)) throw new StockError('Not enough stock there any more — someone else has just moved or used it. Look again and retry.');
    if (twoPeopleViolation(err)) throw new StockError('The person who counted or asked cannot also approve it.');
    throw err;
  }
}

async function locationInTx(tx: Tx, locationId: string) {
  const [row] = await tx
    .select({ id: stockLocations.id, branchId: stockLocations.branchId, name: stockLocations.name, kind: stockLocations.kind, active: stockLocations.active })
    .from(stockLocations)
    .where(eq(stockLocations.id, locationId));
  if (!row) throw new StockError('Store not found');
  return row;
}

/** B4a covers risk-class medicines only: anything else is refused, by name. */
async function riskMedicineInTx(tx: Tx, medicineId: string) {
  const [row] = await tx
    .select({ id: medicines.id, name: medicines.name, strength: medicines.strength, riskClassId: medicineRiskClasses.riskClassId })
    .from(medicines)
    .leftJoin(medicineRiskClasses, eq(medicineRiskClasses.medicineId, medicines.id))
    .where(eq(medicines.id, medicineId));
  if (!row) throw new StockError('Medicine not found');
  if (!row.riskClassId) throw new StockError(`${row.name} is not in a risk class. The owner adds it under Settings → Stock.`);
  return row;
}

async function batchInTx(tx: Tx, args: { hospitalId: string; medicineId: string; batchNo: string; expiryDate: string; actorUserId: string }) {
  const batchNo = parseBatchNo(args.batchNo);
  const expiryDate = parseExpiry(args.expiryDate);
  const [existing] = await tx
    .select({ id: stockBatches.id, expiryDate: stockBatches.expiryDate })
    .from(stockBatches)
    .where(and(eq(stockBatches.medicineId, args.medicineId), sql`upper(${stockBatches.batchNo}) = ${batchNo}`));
  if (existing) {
    if (existing.expiryDate !== expiryDate) {
      throw new StockError(`Batch ${batchNo} was entered before with expiry ${existing.expiryDate}. Check the strip.`);
    }
    return existing.id;
  }
  const [created] = await tx
    .insert(stockBatches)
    .values({ hospitalId: args.hospitalId, medicineId: args.medicineId, batchNo, expiryDate, createdByUserId: args.actorUserId })
    .returning({ id: stockBatches.id });
  return created.id;
}

async function balanceInTx(tx: Tx, locationId: string, batchId: string): Promise<number> {
  const [row] = await tx
    .select({ quantity: stockBalances.quantity })
    .from(stockBalances)
    .where(and(eq(stockBalances.locationId, locationId), eq(stockBalances.batchId, batchId)));
  return row?.quantity ?? 0;
}

/* -------------------------------------------------------------- settings */

export type StockLocation = { id: string; name: string; kind: LocationKind; branchId: string; branchName: string; wardId: string | null; wardName: string | null; active: boolean };

export async function listLocations(hospitalId: string, options: { includeInactive?: boolean } = {}): Promise<StockLocation[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: stockLocations.id,
        name: stockLocations.name,
        kind: stockLocations.kind,
        branchId: stockLocations.branchId,
        branchName: branches.name,
        wardId: stockLocations.wardId,
        wardName: wards.name,
        active: stockLocations.active,
      })
      .from(stockLocations)
      .innerJoin(branches, eq(branches.id, stockLocations.branchId))
      .leftJoin(wards, eq(wards.id, stockLocations.wardId))
      .where(options.includeInactive ? undefined : eq(stockLocations.active, true))
      .orderBy(asc(stockLocations.kind), asc(stockLocations.name)),
  );
}

export async function createLocation(args: {
  hospitalId: string;
  branchId: string;
  name: string;
  kind: LocationKind;
  wardId: string | null;
  actorUserId: string;
}): Promise<string> {
  const name = args.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw new StockError('Give the store a name (2–60 letters)');
  return inTx(args.hospitalId, async (tx) => {
    const [clash] = await tx
      .select({ id: stockLocations.id })
      .from(stockLocations)
      .where(and(eq(stockLocations.branchId, args.branchId), sql`lower(${stockLocations.name}) = ${name.toLowerCase()}`));
    if (clash) throw new StockError(`There is already a store called ${name}`);
    const [row] = await tx
      .insert(stockLocations)
      .values({ hospitalId: args.hospitalId, branchId: args.branchId, name, kind: args.kind, wardId: args.wardId })
      .returning({ id: stockLocations.id });
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'stock.location_created', objectType: 'stock_location', objectId: row.id, metadata: { kind: args.kind } });
    return row.id;
  });
}

export async function setLocationActive(args: { hospitalId: string; locationId: string; active: boolean; actorUserId: string }) {
  return inTx(args.hospitalId, async (tx) => {
    if (!args.active) {
      const [held] = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(stockBalances)
        .where(and(eq(stockBalances.locationId, args.locationId), gt(stockBalances.quantity, 0)));
      if (held.n > 0) throw new StockError('This store still holds stock. Send it elsewhere first.');
    }
    await tx.update(stockLocations).set({ active: args.active }).where(eq(stockLocations.id, args.locationId));
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: args.active ? 'stock.location_reopened' : 'stock.location_closed', objectType: 'stock_location', objectId: args.locationId });
  });
}

export type RiskClass = { id: string; name: string; kind: RiskKind; countEvery: 'daily' | 'weekly'; witnessAtGive: boolean; medicines: number };

export async function listRiskClasses(hospitalId: string): Promise<RiskClass[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: riskClasses.id,
        name: riskClasses.name,
        kind: riskClasses.kind,
        countEvery: riskClasses.countEvery,
        witnessAtGive: riskClasses.witnessAtGive,
        medicines: sql<number>`(select count(*)::int from medicine_risk_classes m where m.risk_class_id = ${riskClasses.id})`,
      })
      .from(riskClasses)
      .where(isNull(riskClasses.archivedAt))
      .orderBy(asc(riskClasses.name)),
  );
}

export async function createRiskClass(args: { hospitalId: string; name: string; kind: RiskKind; countEvery: 'daily' | 'weekly'; witnessAtGive?: boolean; actorUserId: string }) {
  const name = args.name.trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 60) throw new StockError('Give the risk class a name (2–60 letters)');
  return inTx(args.hospitalId, async (tx) => {
    const [clash] = await tx.select({ id: riskClasses.id }).from(riskClasses).where(sql`lower(${riskClasses.name}) = ${name.toLowerCase()}`);
    if (clash) throw new StockError(`There is already a risk class called ${name}`);
    const [row] = await tx
      .insert(riskClasses)
      .values({ hospitalId: args.hospitalId, name, kind: args.kind, countEvery: args.countEvery, witnessAtGive: args.witnessAtGive ?? false, createdByUserId: args.actorUserId })
      .returning({ id: riskClasses.id });
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'stock.risk_class_created', objectType: 'risk_class', objectId: row.id, metadata: { kind: args.kind, countEvery: args.countEvery } });
    return row.id;
  });
}

/** Whether gives of this class need a witness on the MAR (B3-min, D-WITNESS). NDPS always do. */
export async function setRiskClassWitness(args: { hospitalId: string; riskClassId: string; witnessAtGive: boolean; actorUserId: string }) {
  await inTx(args.hospitalId, async (tx) => {
    const updated = await tx
      .update(riskClasses)
      .set({ witnessAtGive: args.witnessAtGive })
      .where(eq(riskClasses.id, args.riskClassId))
      .returning({ id: riskClasses.id });
    if (updated.length === 0) throw new StockError('Risk class not found');
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'stock.risk_class_witness', objectType: 'risk_class', objectId: args.riskClassId, metadata: { witnessAtGive: args.witnessAtGive } });
  });
}

export type MedicineForStock = { id: string; label: string; unit: string; riskClassId: string | null; riskClassName: string | null; countEvery: 'daily' | 'weekly' | null };

const medicineLabel = (m: { name: string; strength: string | null; form: string | null }) =>
  [m.name, m.strength, m.form].filter(Boolean).join(' ');

/** Active medicines with their risk class, for Settings (all) or for pickers (`riskOnly`). */
export async function listMedicinesForStock(hospitalId: string, options: { riskOnly?: boolean } = {}): Promise<MedicineForStock[]> {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: medicines.id,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        unit: medicines.unit,
        riskClassId: riskClasses.id,
        riskClassName: riskClasses.name,
        countEvery: riskClasses.countEvery,
      })
      .from(medicines)
      .leftJoin(medicineRiskClasses, eq(medicineRiskClasses.medicineId, medicines.id))
      .leftJoin(riskClasses, eq(riskClasses.id, medicineRiskClasses.riskClassId))
      .where(options.riskOnly ? and(eq(medicines.active, true), sql`${riskClasses.id} is not null`) : eq(medicines.active, true))
      .orderBy(asc(medicines.name)),
  );
  return rows.map((row) => ({ ...row, label: medicineLabel(row) }));
}

export async function setMedicineRiskClass(args: { hospitalId: string; medicineId: string; riskClassId: string | null; actorUserId: string }) {
  return inTx(args.hospitalId, async (tx) => {
    if (args.riskClassId === null) {
      const [held] = await tx
        .select({ n: sql<number>`coalesce(sum(${stockBalances.quantity}), 0)::int` })
        .from(stockBalances)
        .where(eq(stockBalances.medicineId, args.medicineId));
      if (held.n > 0) throw new StockError('This medicine is still held in stores. It stays in its risk class until none is left.');
      await tx.delete(medicineRiskClasses).where(eq(medicineRiskClasses.medicineId, args.medicineId));
    } else {
      await tx
        .insert(medicineRiskClasses)
        .values({ hospitalId: args.hospitalId, medicineId: args.medicineId, riskClassId: args.riskClassId, assignedByUserId: args.actorUserId })
        .onConflictDoUpdate({
          target: [medicineRiskClasses.hospitalId, medicineRiskClasses.medicineId],
          set: { riskClassId: args.riskClassId, assignedByUserId: args.actorUserId, assignedAt: new Date() },
        });
    }
    await audit(tx, { hospitalId: args.hospitalId, actorUserId: args.actorUserId, action: 'stock.risk_class_assigned', objectType: 'medicine', objectId: args.medicineId, metadata: { riskClassId: args.riskClassId } });
  });
}

/* -------------------------------------------------------------- receive */

export type ReceiptLine = { medicineId: string; batchNo: string; expiry: string; quantity: number };

/** Stock in from a supplier, against the invoice. A retry with the same client id is one receipt. */
export async function receiveStock(args: {
  hospitalId: string;
  locationId: string;
  supplierName: string;
  invoiceNo: string;
  invoiceDate: string;
  lines: readonly ReceiptLine[];
  actorUserId: string;
  clientId: string;
  today: string;
}): Promise<{ receiptId: string; repeat: boolean }> {
  const supplier = args.supplierName.trim().replace(/\s+/g, ' ');
  const invoiceNo = args.invoiceNo.trim();
  if (supplier.length < 2) throw new StockError('Type the supplier’s name');
  if (!invoiceNo || invoiceNo.length > 40) throw new StockError('Type the invoice number');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(args.invoiceDate) || args.invoiceDate > args.today) throw new StockError('Give the invoice date (not in the future)');
  if (args.lines.length === 0) throw new StockError('Add at least one medicine');
  if (args.lines.length > 50) throw new StockError('At most 50 lines on one receipt');

  return inTx(args.hospitalId, async (tx) => {
    const [existing] = await tx.select({ id: purchaseReceipts.id }).from(purchaseReceipts).where(eq(purchaseReceipts.clientId, args.clientId));
    if (existing) return { receiptId: existing.id, repeat: true };
    const location = await locationInTx(tx, args.locationId);
    if (!location.active) throw new StockError('That store is closed');

    const [receipt] = await tx
      .insert(purchaseReceipts)
      .values({
        hospitalId: args.hospitalId,
        branchId: location.branchId,
        locationId: location.id,
        supplierName: supplier,
        invoiceNo,
        invoiceDate: args.invoiceDate,
        receivedByUserId: args.actorUserId,
        clientId: args.clientId,
      })
      .returning({ id: purchaseReceipts.id });

    for (const line of args.lines) {
      const medicine = await riskMedicineInTx(tx, line.medicineId);
      const expiry = parseExpiry(line.expiry);
      if (expiryStatus(expiry, args.today) === 'expired') throw new StockError(`${medicine.name} batch ${line.batchNo} has expired. Do not receive it.`);
      if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 100_000) throw new StockError(`${medicine.name}: quantity must be a whole number`);
      const batchId = await batchInTx(tx, { hospitalId: args.hospitalId, medicineId: line.medicineId, batchNo: line.batchNo, expiryDate: expiry, actorUserId: args.actorUserId });
      await tx.insert(stockLedger).values({
        hospitalId: args.hospitalId,
        locationId: location.id,
        medicineId: line.medicineId,
        batchId,
        kind: 'receive',
        quantity: line.quantity,
        recordedByUserId: args.actorUserId,
        receiptId: receipt.id,
      });
    }
    return { receiptId: receipt.id, repeat: false };
  });
}

/* -------------------------------------------------------------- transfers */

/** Sends stock from one store to another. It leaves the sender now and arrives when the receiver confirms. */
export async function sendTransfer(args: {
  hospitalId: string;
  fromLocationId: string;
  toLocationId: string;
  lines: readonly { batchId: string; quantity: number }[];
  actorUserId: string;
  clientId: string;
}): Promise<{ transferId: string; repeat: boolean }> {
  if (args.fromLocationId === args.toLocationId) throw new StockError('Choose two different stores');
  const lines = args.lines.filter((line) => line.quantity > 0);
  if (lines.length === 0) throw new StockError('Enter how many to send');
  return inTx(args.hospitalId, async (tx) => {
    const [existing] = await tx.select({ id: stockTransfers.id }).from(stockTransfers).where(eq(stockTransfers.clientId, args.clientId));
    if (existing) return { transferId: existing.id, repeat: true };
    const from = await locationInTx(tx, args.fromLocationId);
    const to = await locationInTx(tx, args.toLocationId);
    if (!from.active || !to.active) throw new StockError('One of the stores is closed');

    const [transfer] = await tx
      .insert(stockTransfers)
      .values({ hospitalId: args.hospitalId, fromLocationId: from.id, toLocationId: to.id, sentByUserId: args.actorUserId, clientId: args.clientId })
      .returning({ id: stockTransfers.id });

    for (const line of lines) {
      const [batch] = await tx
        .select({ medicineId: stockBatches.medicineId, batchNo: stockBatches.batchNo, name: medicines.name })
        .from(stockBatches)
        .innerJoin(medicines, eq(medicines.id, stockBatches.medicineId))
        .where(eq(stockBatches.id, line.batchId));
      if (!batch) throw new StockError('Batch not found');
      const held = await balanceInTx(tx, from.id, line.batchId);
      if (line.quantity > held) throw new StockError(`${batch.name} batch ${batch.batchNo}: only ${held} in ${from.name}`);
      await tx.insert(stockTransferLines).values({
        hospitalId: args.hospitalId,
        transferId: transfer.id,
        medicineId: batch.medicineId,
        batchId: line.batchId,
        quantitySent: line.quantity,
      });
      await tx.insert(stockLedger).values({
        hospitalId: args.hospitalId,
        locationId: from.id,
        medicineId: batch.medicineId,
        batchId: line.batchId,
        kind: 'transfer_out',
        quantity: -line.quantity,
        recordedByUserId: args.actorUserId,
        transferId: transfer.id,
      });
    }
    return { transferId: transfer.id, repeat: false };
  });
}

/**
 * The receiving store confirms what arrived, line by line. Less than was sent
 * is allowed and kept on the transfer as a shortfall — it shows on the stock
 * page as lost in transit — but more is not.
 */
export async function receiveTransfer(args: {
  hospitalId: string;
  transferId: string;
  received: readonly { lineId: string; quantity: number }[];
  actorUserId: string;
}): Promise<{ shortfall: number }> {
  return inTx(args.hospitalId, async (tx) => {
    const [transfer] = await tx.select().from(stockTransfers).where(eq(stockTransfers.id, args.transferId)).for('update');
    if (!transfer) throw new StockError('Transfer not found');
    if (transfer.status !== 'in_transit') throw new StockError('This delivery has already been taken in');
    const lines = await tx.select().from(stockTransferLines).where(eq(stockTransferLines.transferId, transfer.id));
    const byId = new Map(args.received.map((r) => [r.lineId, r.quantity]));
    let shortfall = 0;
    for (const line of lines) {
      const quantity = byId.get(line.id);
      if (quantity === undefined || !Number.isInteger(quantity) || quantity < 0 || quantity > line.quantitySent) {
        throw new StockError('Enter what arrived on every line (no more than was sent)');
      }
      shortfall += line.quantitySent - quantity;
      await tx.update(stockTransferLines).set({ quantityReceived: quantity }).where(eq(stockTransferLines.id, line.id));
      if (quantity > 0) {
        await tx.insert(stockLedger).values({
          hospitalId: args.hospitalId,
          locationId: transfer.toLocationId,
          medicineId: line.medicineId,
          batchId: line.batchId,
          kind: 'transfer_in',
          quantity,
          recordedByUserId: args.actorUserId,
          transferId: transfer.id,
        });
      }
    }
    await tx
      .update(stockTransfers)
      .set({ status: 'received', receivedAt: new Date(), receivedByUserId: args.actorUserId })
      .where(eq(stockTransfers.id, transfer.id));
    return { shortfall };
  });
}

export type TransferView = {
  id: string;
  fromName: string;
  toName: string;
  toLocationId: string;
  status: 'in_transit' | 'received';
  sentAt: Date;
  sentByName: string | null;
  receivedAt: Date | null;
  receivedByName: string | null;
  lines: { id: string; label: string; batchNo: string; expiryDate: string; sent: number; received: number | null }[];
};

export async function getTransfer(hospitalId: string, transferId: string): Promise<TransferView | null> {
  return withTenant(hospitalId, async (tx) => {
    const fromLoc = sql`(select name from stock_locations l where l.id = ${stockTransfers.fromLocationId})`;
    const toLoc = sql`(select name from stock_locations l where l.id = ${stockTransfers.toLocationId})`;
    const [transfer] = await tx
      .select({
        id: stockTransfers.id,
        fromName: sql<string>`${fromLoc}`,
        toName: sql<string>`${toLoc}`,
        toLocationId: stockTransfers.toLocationId,
        status: stockTransfers.status,
        sentAt: stockTransfers.sentAt,
        sentByName: sql<string | null>`(select name from users u where u.id = ${stockTransfers.sentByUserId})`,
        receivedAt: stockTransfers.receivedAt,
        receivedByName: sql<string | null>`(select name from users u where u.id = ${stockTransfers.receivedByUserId})`,
      })
      .from(stockTransfers)
      .where(eq(stockTransfers.id, transferId));
    if (!transfer) return null;
    const lines = await tx
      .select({
        id: stockTransferLines.id,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        batchNo: stockBatches.batchNo,
        expiryDate: stockBatches.expiryDate,
        sent: stockTransferLines.quantitySent,
        received: stockTransferLines.quantityReceived,
      })
      .from(stockTransferLines)
      .innerJoin(medicines, eq(medicines.id, stockTransferLines.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockTransferLines.batchId))
      .where(eq(stockTransferLines.transferId, transferId))
      .orderBy(asc(medicines.name));
    return { ...transfer, lines: lines.map((l) => ({ ...l, label: medicineLabel(l) })) };
  });
}

/* -------------------------------------------------------------- stock on hand */

export type OnHand = {
  medicineId: string;
  label: string;
  unit: string;
  batchId: string;
  batchNo: string;
  expiryDate: string;
  quantity: number;
  expiry: 'expired' | 'soon' | 'ok';
};

/** What a store holds, by medicine and batch (first expiry first), from the balances the ledger keeps. */
export async function getOnHand(hospitalId: string, locationId: string, today: string): Promise<OnHand[]> {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        medicineId: stockBalances.medicineId,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        unit: medicines.unit,
        batchId: stockBalances.batchId,
        batchNo: stockBatches.batchNo,
        expiryDate: stockBatches.expiryDate,
        quantity: stockBalances.quantity,
      })
      .from(stockBalances)
      .innerJoin(medicines, eq(medicines.id, stockBalances.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
      .where(and(eq(stockBalances.locationId, locationId), gt(stockBalances.quantity, 0))),
  );
  const sorted = rows
    .map((row) => ({ ...row, label: medicineLabel(row), expiry: expiryStatus(row.expiryDate, today) }))
    .sort((a, b) => a.label.localeCompare(b.label));
  // Within a medicine, first expiry first.
  const byMedicine = new Map<string, typeof sorted>();
  for (const row of sorted) byMedicine.set(row.medicineId, [...(byMedicine.get(row.medicineId) ?? []), row]);
  return [...byMedicine.values()].flatMap((list) => fefo(list));
}

export type Movement = {
  id: string;
  kind: string;
  quantity: number;
  source: 'app' | 'manual_register';
  label: string;
  batchNo: string;
  recordedAt: Date;
  recordedByName: string | null;
  countId: string | null;
  transferId: string | null;
};

export async function listMovements(hospitalId: string, locationId: string, limit = 50): Promise<Movement[]> {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: stockLedger.id,
        kind: stockLedger.kind,
        quantity: stockLedger.quantity,
        source: stockLedger.source,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        batchNo: stockBatches.batchNo,
        recordedAt: stockLedger.recordedAt,
        recordedByName: users.name,
        countId: stockLedger.countId,
        transferId: stockLedger.transferId,
      })
      .from(stockLedger)
      .innerJoin(medicines, eq(medicines.id, stockLedger.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockLedger.batchId))
      .leftJoin(users, eq(users.id, stockLedger.recordedByUserId))
      .where(eq(stockLedger.locationId, locationId))
      .orderBy(desc(stockLedger.recordedAt))
      .limit(limit),
  );
  return rows.map((row) => ({ ...row, label: medicineLabel(row) }));
}

/* -------------------------------------------------------------- counts */

/**
 * Starts a blind count of one store. Plan §7.2: whoever moved stock in or out
 * of this store since its last approved count should not count it. In the
 * module's `observe` and `warn` stages such a count goes ahead, flagged; in
 * `enforce` it is refused.
 */
export async function startCount(args: {
  hospitalId: string;
  locationId: string;
  actorUserId: string;
  clientId: string;
  stage: ModuleStage;
}): Promise<{ countId: string; flagged: boolean }> {
  return inTx(args.hospitalId, async (tx) => {
    const [existing] = await tx.select({ id: stockCounts.id, mover: stockCounts.countedByMover }).from(stockCounts).where(eq(stockCounts.clientId, args.clientId));
    if (existing) return { countId: existing.id, flagged: existing.mover };
    const location = await locationInTx(tx, args.locationId);
    const [open] = await tx
      .select({ id: stockCounts.id })
      .from(stockCounts)
      .where(and(eq(stockCounts.locationId, location.id), inArray(stockCounts.status, ['counting', 'submitted'])));
    if (open) throw new StockError('A count of this store is already open. Finish or cancel it first.');

    const [last] = await tx
      .select({ approvedAt: stockCounts.approvedAt })
      .from(stockCounts)
      .where(and(eq(stockCounts.locationId, location.id), eq(stockCounts.status, 'approved')))
      .orderBy(desc(stockCounts.approvedAt))
      .limit(1);
    const since = last?.approvedAt ?? new Date(Date.now() - 30 * 86_400_000);
    const [moved] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockLedger)
      .where(
        and(
          eq(stockLedger.locationId, location.id),
          eq(stockLedger.recordedByUserId, args.actorUserId),
          gt(stockLedger.recordedAt, since),
          ne(stockLedger.kind, 'count_variance'),
          ne(stockLedger.source, 'manual_register'),
        ),
      );
    const mover = moved.n > 0;
    if (mover && args.stage === 'enforce') {
      throw new StockError('You moved stock in or out of this store since its last count. Someone else must count it.');
    }
    const [count] = await tx
      .insert(stockCounts)
      .values({
        hospitalId: args.hospitalId,
        branchId: location.branchId,
        locationId: location.id,
        countedByUserId: args.actorUserId,
        countedByMover: mover,
        clientId: args.clientId,
      })
      .returning({ id: stockCounts.id });
    return { countId: count.id, flagged: mover };
  });
}

export type CountSheetLine = {
  lineId: string | null;
  medicineId: string;
  label: string;
  unit: string;
  batchId: string;
  batchNo: string;
  expiryDate: string;
  counted: number | null;
  /** Only once submitted: the blind count never shows the book before. */
  book: number | null;
  usedAllocated: number;
  variance: number | null;
  reasonCode: VarianceReason | null;
  reasonText: string | null;
};

export type CountView = {
  id: string;
  locationId: string;
  locationName: string;
  status: 'counting' | 'submitted' | 'approved' | 'cancelled';
  countedByUserId: string;
  countedByName: string | null;
  approvedByName: string | null;
  startedAt: Date;
  submittedAt: Date | null;
  approvedAt: Date | null;
  countedByMover: boolean;
  movedDuringCount: boolean;
  lines: CountSheetLine[];
  manualUse: Map<string, number>;
  /** Per medicine, the register's "used" figure beyond what the books held. */
  overUse: Map<string, number>;
};

/** The batches a count must cover: what the books say the store holds of risk-class medicines, and anything already counted. */
async function sheetBatchesInTx(tx: Tx, locationId: string, countId: string) {
  const held = await tx
    .select({ batchId: stockBalances.batchId, medicineId: stockBalances.medicineId, quantity: stockBalances.quantity })
    .from(stockBalances)
    .innerJoin(medicineRiskClasses, eq(medicineRiskClasses.medicineId, stockBalances.medicineId))
    .where(and(eq(stockBalances.locationId, locationId), gt(stockBalances.quantity, 0)));
  const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, countId));
  return { held, lines };
}

export async function getCount(hospitalId: string, countId: string): Promise<CountView | null> {
  return withTenant(hospitalId, async (tx) => {
    const [count] = await tx
      .select({
        id: stockCounts.id,
        locationId: stockCounts.locationId,
        locationName: stockLocations.name,
        status: stockCounts.status,
        countedByUserId: stockCounts.countedByUserId,
        countedByName: sql<string | null>`(select name from users u where u.id = ${stockCounts.countedByUserId})`,
        approvedByName: sql<string | null>`(select name from users u where u.id = ${stockCounts.approvedByUserId})`,
        startedAt: stockCounts.startedAt,
        submittedAt: stockCounts.submittedAt,
        approvedAt: stockCounts.approvedAt,
        countedByMover: stockCounts.countedByMover,
        movedDuringCount: stockCounts.movedDuringCount,
      })
      .from(stockCounts)
      .innerJoin(stockLocations, eq(stockLocations.id, stockCounts.locationId))
      .where(eq(stockCounts.id, countId));
    if (!count) return null;

    const { held, lines } = await sheetBatchesInTx(tx, count.locationId, count.id);
    const batchIds = [...new Set([...held.map((h) => h.batchId), ...lines.map((l) => l.batchId)])];
    const details = batchIds.length
      ? await tx
          .select({
            batchId: stockBatches.id,
            medicineId: stockBatches.medicineId,
            batchNo: stockBatches.batchNo,
            expiryDate: stockBatches.expiryDate,
            name: medicines.name,
            strength: medicines.strength,
            form: medicines.form,
            unit: medicines.unit,
          })
          .from(stockBatches)
          .innerJoin(medicines, eq(medicines.id, stockBatches.medicineId))
          .where(inArray(stockBatches.id, batchIds))
      : [];
    const lineByBatch = new Map(lines.map((l) => [l.batchId, l]));
    // While counting, the sheet is what the books say is there; after, it is exactly what was counted.
    const sheetIds = count.status === 'counting' ? batchIds : lines.map((l) => l.batchId);
    const sheet: CountSheetLine[] = details
      .filter((d) => sheetIds.includes(d.batchId))
      .map((d) => {
        const line = lineByBatch.get(d.batchId);
        const blind = count.status === 'counting';
        return {
          lineId: line?.id ?? null,
          medicineId: d.medicineId,
          label: medicineLabel(d),
          unit: d.unit,
          batchId: d.batchId,
          batchNo: d.batchNo,
          expiryDate: d.expiryDate,
          counted: line?.countedQty ?? null,
          book: blind ? null : (line?.bookQty ?? null),
          usedAllocated: blind ? 0 : (line?.usedAllocated ?? 0),
          variance: blind ? null : (line?.variance ?? null),
          reasonCode: (line?.reasonCode as VarianceReason | null) ?? null,
          reasonText: line?.reasonText ?? null,
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label) || a.expiryDate.localeCompare(b.expiryDate));

    const use = await tx.select().from(stockCountManualUse).where(eq(stockCountManualUse.countId, count.id));
    const manualUse = new Map(use.map((u) => [u.medicineId, u.usedQty]));
    const overUse = new Map<string, number>();
    if (count.status !== 'counting') {
      for (const [medicineId, used] of manualUse) {
        const allocated = sheet.filter((l) => l.medicineId === medicineId).reduce((sum, l) => sum + l.usedAllocated, 0);
        if (used > allocated) overUse.set(medicineId, used - allocated);
      }
    }
    return { ...count, lines: sheet, manualUse, overUse };
  });
}

async function openCountInTx(tx: Tx, countId: string, actorUserId: string) {
  const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, countId)).for('update');
  if (!count) throw new StockError('Count not found');
  if (count.status !== 'counting') throw new StockError('This count has been submitted');
  if (count.countedByUserId !== actorUserId) throw new StockError('Only the person who started this count can fill it in');
  return count;
}

/**
 * Saves what has been counted so far: numbers per batch, the register's
 * "used since last count" per medicine, and any batch found on the shelf that
 * the books did not list.
 */
export async function saveCount(args: {
  hospitalId: string;
  countId: string;
  actorUserId: string;
  counted: readonly { batchId: string; quantity: number | null }[];
  manualUse: readonly { medicineId: string; used: number | null }[];
  found?: { medicineId: string; batchNo: string; expiry: string; quantity: number } | null;
}): Promise<void> {
  return inTx(args.hospitalId, async (tx) => {
    const count = await openCountInTx(tx, args.countId, args.actorUserId);
    const save = async (batchId: string, medicineId: string, quantity: number | null) => {
      if (quantity !== null && (!Number.isInteger(quantity) || quantity < 0 || quantity > 100_000)) throw new StockError('Counts are whole numbers, 0 or more');
      const [line] = await tx
        .select({ id: stockCountLines.id })
        .from(stockCountLines)
        .where(and(eq(stockCountLines.countId, count.id), eq(stockCountLines.batchId, batchId)));
      if (line) {
        await tx.update(stockCountLines).set({ countedQty: quantity }).where(eq(stockCountLines.id, line.id));
      } else if (quantity !== null) {
        await tx.insert(stockCountLines).values({ hospitalId: args.hospitalId, countId: count.id, medicineId, batchId, countedQty: quantity });
      }
    };
    for (const entry of args.counted) {
      const [batch] = await tx.select({ medicineId: stockBatches.medicineId }).from(stockBatches).where(eq(stockBatches.id, entry.batchId));
      if (!batch) throw new StockError('Batch not found');
      await save(entry.batchId, batch.medicineId, entry.quantity);
    }
    if (args.found) {
      await riskMedicineInTx(tx, args.found.medicineId);
      const batchId = await batchInTx(tx, { hospitalId: args.hospitalId, medicineId: args.found.medicineId, batchNo: args.found.batchNo, expiryDate: args.found.expiry, actorUserId: args.actorUserId });
      await save(batchId, args.found.medicineId, args.found.quantity);
    }
    for (const use of args.manualUse) {
      if (use.used === null) {
        await tx.delete(stockCountManualUse).where(and(eq(stockCountManualUse.countId, count.id), eq(stockCountManualUse.medicineId, use.medicineId)));
        continue;
      }
      if (!Number.isInteger(use.used) || use.used < 0 || use.used > 100_000) throw new StockError('“Used” is a whole number, 0 or more');
      await tx
        .insert(stockCountManualUse)
        .values({ hospitalId: args.hospitalId, countId: count.id, medicineId: use.medicineId, usedQty: use.used })
        .onConflictDoUpdate({ target: [stockCountManualUse.countId, stockCountManualUse.medicineId], set: { usedQty: use.used } });
    }
  });
}

/**
 * Submits a count: every batch the books list must have a number. Only now
 * are the books read, the register's "used" figure spread over the batches
 * (first expiry first), and the differences worked out. If stock moved in or
 * out of the store while it was being counted, the count says so.
 */
export async function submitCount(args: { hospitalId: string; countId: string; actorUserId: string }): Promise<{ differences: number }> {
  return inTx(args.hospitalId, async (tx) => {
    const count = await openCountInTx(tx, args.countId, args.actorUserId);
    const { held, lines } = await sheetBatchesInTx(tx, count.locationId, count.id);
    const lineByBatch = new Map(lines.map((l) => [l.batchId, l]));
    const missing = held.filter((h) => lineByBatch.get(h.batchId)?.countedQty == null);
    if (missing.length > 0) throw new StockError(`Count every line — ${missing.length} still empty. Type 0 if there are none.`);
    const counted = lines.filter((l) => l.countedQty !== null);
    if (counted.length === 0) throw new StockError('Nothing has been counted');

    const bookByBatch = new Map(held.map((h) => [h.batchId, h.quantity]));
    const batches = await tx
      .select({ id: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate })
      .from(stockBatches)
      .where(inArray(stockBatches.id, counted.map((l) => l.batchId)));
    const batchById = new Map(batches.map((b) => [b.id, b]));
    const use = await tx.select().from(stockCountManualUse).where(eq(stockCountManualUse.countId, count.id));

    const outcome = countOutcome(
      counted.map((l) => ({
        batchId: l.batchId,
        medicineId: l.medicineId,
        batchNo: batchById.get(l.batchId)!.batchNo,
        expiryDate: batchById.get(l.batchId)!.expiryDate,
        counted: l.countedQty!,
        book: bookByBatch.get(l.batchId) ?? 0,
      })),
      new Map(use.map((u) => [u.medicineId, u.usedQty])),
    );
    let differences = 0;
    for (const result of outcome.lines) {
      if (result.variance !== 0) differences += 1;
      await tx
        .update(stockCountLines)
        .set({ bookQty: bookByBatch.get(result.batchId) ?? 0, usedAllocated: result.usedAllocated, variance: result.variance })
        .where(and(eq(stockCountLines.countId, count.id), eq(stockCountLines.batchId, result.batchId)));
    }
    // Drop empty lines for batches that turned out not to be counted (a found batch left blank).
    await tx.delete(stockCountLines).where(and(eq(stockCountLines.countId, count.id), isNull(stockCountLines.countedQty)));

    const [moved] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(stockLedger)
      .where(and(eq(stockLedger.locationId, count.locationId), gt(stockLedger.recordedAt, count.startedAt)));
    await tx
      .update(stockCounts)
      .set({ status: 'submitted', submittedAt: new Date(), movedDuringCount: moved.n > 0 })
      .where(eq(stockCounts.id, count.id));
    return { differences };
  });
}

/** The counter, or whoever will approve, says why a line differs. Required before approval. */
export async function explainDifference(args: {
  hospitalId: string;
  countId: string;
  batchId: string;
  reasonCode: string;
  reasonText: string;
  actorUserId: string;
}): Promise<void> {
  if (!isVarianceReason(args.reasonCode)) throw new StockError('Choose a reason');
  const text = args.reasonText.trim().replace(/\s+/g, ' ');
  if (args.reasonCode === 'other' && text.length < 3) throw new StockError('Say what happened');
  if (text.length > 200) throw new StockError('Keep it under 200 letters');
  return inTx(args.hospitalId, async (tx) => {
    const [count] = await tx.select({ status: stockCounts.status }).from(stockCounts).where(eq(stockCounts.id, args.countId));
    if (!count) throw new StockError('Count not found');
    if (count.status !== 'submitted') throw new StockError('Differences are explained after the count is submitted and before it is approved');
    await tx
      .update(stockCountLines)
      .set({ reasonCode: args.reasonCode, reasonText: text || null, explainedByUserId: args.actorUserId })
      .where(and(eq(stockCountLines.countId, args.countId), eq(stockCountLines.batchId, args.batchId)));
  });
}

/**
 * A second person approves a submitted count. The register's "used" figure
 * is posted as use (marked as copied from the paper register), and each
 * difference as a count difference, so the books now match the shelf.
 */
export async function approveCount(args: { hospitalId: string; countId: string; actorUserId: string }): Promise<void> {
  return inTx(args.hospitalId, async (tx) => {
    const [count] = await tx.select().from(stockCounts).where(eq(stockCounts.id, args.countId)).for('update');
    if (!count) throw new StockError('Count not found');
    if (count.status !== 'submitted') throw new StockError('Only a submitted count can be approved');
    if (count.countedByUserId === args.actorUserId) throw new StockError('Someone other than the counter must approve the count');
    const lines = await tx.select().from(stockCountLines).where(eq(stockCountLines.countId, count.id));
    const unexplained = lines.filter((l) => (l.variance ?? 0) !== 0 && !l.reasonCode);
    if (unexplained.length > 0) throw new StockError(`${unexplained.length} difference${unexplained.length === 1 ? ' needs' : 's need'} a reason first`);
    for (const line of lines) {
      const base = { hospitalId: args.hospitalId, locationId: count.locationId, medicineId: line.medicineId, batchId: line.batchId, recordedByUserId: args.actorUserId, countId: count.id };
      if (line.usedAllocated > 0) {
        await tx.insert(stockLedger).values({ ...base, kind: 'give', quantity: -line.usedAllocated, source: 'manual_register', occurredAt: count.submittedAt ?? new Date() });
      }
      if (line.variance) {
        await tx.insert(stockLedger).values({ ...base, kind: 'count_variance', quantity: line.variance });
      }
    }
    await tx.update(stockCounts).set({ status: 'approved', approvedAt: new Date(), approvedByUserId: args.actorUserId }).where(eq(stockCounts.id, count.id));
  });
}

export async function cancelCount(args: { hospitalId: string; countId: string; actorUserId: string }): Promise<void> {
  return inTx(args.hospitalId, async (tx) => {
    const count = await openCountInTx(tx, args.countId, args.actorUserId);
    await tx.update(stockCounts).set({ status: 'cancelled' }).where(eq(stockCounts.id, count.id));
  });
}

/* -------------------------------------------------------------- adjustments */

export async function requestAdjustment(args: {
  hospitalId: string;
  locationId: string;
  batchId: string;
  direction: 'in' | 'out';
  quantity: number;
  reasonCode: AdjustReason;
  reasonText: string;
  actorUserId: string;
  clientId: string;
}): Promise<string> {
  const quantity = adjustmentQuantity(args.reasonCode, args.direction, args.quantity);
  const text = args.reasonText.trim().replace(/\s+/g, ' ');
  if (args.reasonCode === 'other' && text.length < 3) throw new StockError('Say what happened');
  return inTx(args.hospitalId, async (tx) => {
    const [existing] = await tx.select({ id: stockAdjustments.id }).from(stockAdjustments).where(eq(stockAdjustments.clientId, args.clientId));
    if (existing) return existing.id;
    await locationInTx(tx, args.locationId);
    const [batch] = await tx.select({ medicineId: stockBatches.medicineId, batchNo: stockBatches.batchNo }).from(stockBatches).where(eq(stockBatches.id, args.batchId));
    if (!batch) throw new StockError('Batch not found');
    await riskMedicineInTx(tx, batch.medicineId);
    if (quantity < 0) {
      const held = await balanceInTx(tx, args.locationId, args.batchId);
      if (-quantity > held) throw new StockError(`Only ${held} of batch ${batch.batchNo} here`);
    }
    const [row] = await tx
      .insert(stockAdjustments)
      .values({
        hospitalId: args.hospitalId,
        locationId: args.locationId,
        medicineId: batch.medicineId,
        batchId: args.batchId,
        quantity,
        reasonCode: args.reasonCode,
        reasonText: text || null,
        requestedByUserId: args.actorUserId,
        clientId: args.clientId,
      })
      .returning({ id: stockAdjustments.id });
    return row.id;
  });
}

/** Approve (post the movement) or reject. Never by the person who asked. */
export async function decideAdjustment(args: { hospitalId: string; adjustmentId: string; approve: boolean; actorUserId: string }): Promise<void> {
  return inTx(args.hospitalId, async (tx) => {
    const [adjustment] = await tx.select().from(stockAdjustments).where(eq(stockAdjustments.id, args.adjustmentId)).for('update');
    if (!adjustment) throw new StockError('Adjustment not found');
    if (adjustment.status !== 'pending') throw new StockError('This adjustment has already been decided');
    if (adjustment.requestedByUserId === args.actorUserId) throw new StockError('Someone other than the person who asked must decide');
    if (args.approve) {
      await tx.insert(stockLedger).values({
        hospitalId: args.hospitalId,
        locationId: adjustment.locationId,
        medicineId: adjustment.medicineId,
        batchId: adjustment.batchId,
        kind: ADJUST_REASONS[adjustment.reasonCode].kind,
        quantity: adjustment.quantity,
        recordedByUserId: args.actorUserId,
        adjustmentId: adjustment.id,
      });
    }
    await tx
      .update(stockAdjustments)
      .set({ status: args.approve ? 'approved' : 'rejected', decidedAt: new Date(), decidedByUserId: args.actorUserId })
      .where(eq(stockAdjustments.id, adjustment.id));
  });
}

export type PendingAdjustment = {
  id: string;
  locationName: string;
  label: string;
  batchNo: string;
  quantity: number;
  reasonCode: AdjustReason;
  reasonText: string | null;
  requestedByUserId: string;
  requestedByName: string | null;
  requestedAt: Date;
};

export async function listPendingAdjustments(hospitalId: string): Promise<PendingAdjustment[]> {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: stockAdjustments.id,
        locationName: stockLocations.name,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        batchNo: stockBatches.batchNo,
        quantity: stockAdjustments.quantity,
        reasonCode: stockAdjustments.reasonCode,
        reasonText: stockAdjustments.reasonText,
        requestedByUserId: stockAdjustments.requestedByUserId,
        requestedByName: users.name,
        requestedAt: stockAdjustments.requestedAt,
      })
      .from(stockAdjustments)
      .innerJoin(stockLocations, eq(stockLocations.id, stockAdjustments.locationId))
      .innerJoin(medicines, eq(medicines.id, stockAdjustments.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockAdjustments.batchId))
      .leftJoin(users, eq(users.id, stockAdjustments.requestedByUserId))
      .where(eq(stockAdjustments.status, 'pending'))
      .orderBy(asc(stockAdjustments.requestedAt)),
  );
  return rows.map((row) => ({ ...row, label: medicineLabel(row) }));
}

/* -------------------------------------------------------------- overview */

export type StoreSummary = {
  location: StockLocation;
  items: number;
  units: number;
  expired: number;
  expiringSoon: number;
  lastCountAt: Date | null;
  countDue: boolean;
  openCount: { id: string; status: 'counting' | 'submitted'; countedByUserId: string; countedByName: string | null } | null;
  arriving: number;
};

export type StockDifference = {
  countId: string;
  locationName: string;
  label: string;
  batchNo: string;
  variance: number;
  reasonCode: VarianceReason | null;
  reasonText: string | null;
  countedByName: string | null;
  approvedByName: string | null;
  approvedAt: Date;
  countedByMover: boolean;
};

export type StockOverview = {
  stores: StoreSummary[];
  inTransit: { id: string; fromName: string; toName: string; toLocationId: string; sentAt: Date; sentByName: string | null; lines: number }[];
  toApprove: { id: string; locationName: string; countedByUserId: string; countedByName: string | null; submittedAt: Date; differences: number; countedByMover: boolean; movedDuringCount: boolean }[];
  adjustments: PendingAdjustment[];
  differences: StockDifference[];
  /** Lost between stores in the last 7 days: sent but not received. */
  shortfalls: { transferId: string; label: string; batchNo: string; missing: number; fromName: string; toName: string; receivedAt: Date }[];
};

/**
 * The stock page in one call: each store's holding, expiry, and whether today's
 * count is done; deliveries on the way; counts and adjustments waiting for a
 * second person; and the last 7 days' differences and shortfalls. Read on
 * demand, not polled.
 */
export async function getStockOverview(args: { hospitalId: string; timezone: string; now?: Date }): Promise<StockOverview> {
  const now = args.now ?? new Date();
  const today = serviceDateIn(args.timezone, now);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const locations = await listLocations(args.hospitalId);

  return withTenant(args.hospitalId, async (tx) => {
    const holdings = await tx
      .select({
        locationId: stockBalances.locationId,
        medicineId: stockBalances.medicineId,
        quantity: stockBalances.quantity,
        expiryDate: stockBatches.expiryDate,
        countEvery: riskClasses.countEvery,
      })
      .from(stockBalances)
      .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
      .innerJoin(medicineRiskClasses, eq(medicineRiskClasses.medicineId, stockBalances.medicineId))
      .innerJoin(riskClasses, eq(riskClasses.id, medicineRiskClasses.riskClassId))
      .where(gt(stockBalances.quantity, 0));

    const lastCounts = await tx
      .select({ locationId: stockCounts.locationId, at: sql<string>`max(${stockCounts.submittedAt})` })
      .from(stockCounts)
      .where(inArray(stockCounts.status, ['submitted', 'approved']))
      .groupBy(stockCounts.locationId);
    const lastByLocation = new Map(lastCounts.map((c) => [c.locationId, c.at ? new Date(c.at) : null]));

    const open = await tx
      .select({
        id: stockCounts.id,
        locationId: stockCounts.locationId,
        status: stockCounts.status,
        countedByUserId: stockCounts.countedByUserId,
        countedByName: users.name,
        submittedAt: stockCounts.submittedAt,
        countedByMover: stockCounts.countedByMover,
        movedDuringCount: stockCounts.movedDuringCount,
        differences: sql<number>`(select count(*)::int from stock_count_lines l where l.count_id = ${stockCounts.id} and coalesce(l.variance, 0) <> 0)`,
      })
      .from(stockCounts)
      .leftJoin(users, eq(users.id, stockCounts.countedByUserId))
      .where(inArray(stockCounts.status, ['counting', 'submitted']));

    const transit = await tx
      .select({
        id: stockTransfers.id,
        fromName: sql<string>`(select name from stock_locations l where l.id = ${stockTransfers.fromLocationId})`,
        toName: sql<string>`(select name from stock_locations l where l.id = ${stockTransfers.toLocationId})`,
        toLocationId: stockTransfers.toLocationId,
        sentAt: stockTransfers.sentAt,
        sentByName: users.name,
        lines: sql<number>`(select count(*)::int from stock_transfer_lines t where t.transfer_id = ${stockTransfers.id})`,
      })
      .from(stockTransfers)
      .leftJoin(users, eq(users.id, stockTransfers.sentByUserId))
      .where(eq(stockTransfers.status, 'in_transit'))
      .orderBy(asc(stockTransfers.sentAt));

    const differences = await tx
      .select({
        countId: stockCounts.id,
        locationName: stockLocations.name,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        batchNo: stockBatches.batchNo,
        variance: stockCountLines.variance,
        reasonCode: stockCountLines.reasonCode,
        reasonText: stockCountLines.reasonText,
        countedByName: sql<string | null>`(select name from users u where u.id = ${stockCounts.countedByUserId})`,
        approvedByName: sql<string | null>`(select name from users u where u.id = ${stockCounts.approvedByUserId})`,
        approvedAt: stockCounts.approvedAt,
        countedByMover: stockCounts.countedByMover,
      })
      .from(stockCountLines)
      .innerJoin(stockCounts, eq(stockCounts.id, stockCountLines.countId))
      .innerJoin(stockLocations, eq(stockLocations.id, stockCounts.locationId))
      .innerJoin(medicines, eq(medicines.id, stockCountLines.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockCountLines.batchId))
      .where(and(eq(stockCounts.status, 'approved'), gt(stockCounts.approvedAt, weekAgo), ne(stockCountLines.variance, 0)))
      .orderBy(desc(stockCounts.approvedAt));

    const shortfalls = await tx
      .select({
        transferId: stockTransfers.id,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        batchNo: stockBatches.batchNo,
        missing: sql<number>`${stockTransferLines.quantitySent} - ${stockTransferLines.quantityReceived}`,
        fromName: sql<string>`(select name from stock_locations l where l.id = ${stockTransfers.fromLocationId})`,
        toName: sql<string>`(select name from stock_locations l where l.id = ${stockTransfers.toLocationId})`,
        receivedAt: stockTransfers.receivedAt,
      })
      .from(stockTransferLines)
      .innerJoin(stockTransfers, eq(stockTransfers.id, stockTransferLines.transferId))
      .innerJoin(medicines, eq(medicines.id, stockTransferLines.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockTransferLines.batchId))
      .where(and(gt(stockTransfers.receivedAt, weekAgo), sql`${stockTransferLines.quantityReceived} < ${stockTransferLines.quantitySent}`));

    const adjustments = await tx
      .select({
        id: stockAdjustments.id,
        locationName: stockLocations.name,
        name: medicines.name,
        strength: medicines.strength,
        form: medicines.form,
        batchNo: stockBatches.batchNo,
        quantity: stockAdjustments.quantity,
        reasonCode: stockAdjustments.reasonCode,
        reasonText: stockAdjustments.reasonText,
        requestedByUserId: stockAdjustments.requestedByUserId,
        requestedByName: users.name,
        requestedAt: stockAdjustments.requestedAt,
      })
      .from(stockAdjustments)
      .innerJoin(stockLocations, eq(stockLocations.id, stockAdjustments.locationId))
      .innerJoin(medicines, eq(medicines.id, stockAdjustments.medicineId))
      .innerJoin(stockBatches, eq(stockBatches.id, stockAdjustments.batchId))
      .leftJoin(users, eq(users.id, stockAdjustments.requestedByUserId))
      .where(eq(stockAdjustments.status, 'pending'))
      .orderBy(asc(stockAdjustments.requestedAt));

    const stores: StoreSummary[] = locations.map((location) => {
      const mine = holdings.filter((h) => h.locationId === location.id);
      const openCount = open.find((c) => c.locationId === location.id) ?? null;
      const every = mine.some((h) => h.countEvery === 'daily') ? 'daily' : 'weekly';
      const lastCountAt = lastByLocation.get(location.id) ?? null;
      return {
        location,
        items: new Set(mine.map((h) => h.medicineId)).size,
        units: mine.reduce((sum, h) => sum + h.quantity, 0),
        expired: mine.filter((h) => expiryStatus(h.expiryDate, today) === 'expired').length,
        expiringSoon: mine.filter((h) => expiryStatus(h.expiryDate, today) === 'soon').length,
        lastCountAt,
        // A store holding no risk-class stock needs no count.
        countDue: mine.length > 0 && countDue({ lastCountAt, every, now, timezone: args.timezone }),
        openCount: openCount
          ? { id: openCount.id, status: openCount.status as 'counting' | 'submitted', countedByUserId: openCount.countedByUserId, countedByName: openCount.countedByName }
          : null,
        arriving: transit.filter((t) => t.toLocationId === location.id).length,
      };
    });

    return {
      stores,
      inTransit: transit,
      toApprove: open
        .filter((c) => c.status === 'submitted')
        .map((c) => ({
          id: c.id,
          locationName: locations.find((l) => l.id === c.locationId)?.name ?? '',
          countedByUserId: c.countedByUserId,
          countedByName: c.countedByName,
          submittedAt: c.submittedAt!,
          differences: c.differences,
          countedByMover: c.countedByMover,
          movedDuringCount: c.movedDuringCount,
        })),
      adjustments: adjustments.map((a) => ({ ...a, label: medicineLabel(a) })),
      differences: differences.map((d) => ({
        ...d,
        label: medicineLabel(d),
        variance: d.variance ?? 0,
        reasonCode: d.reasonCode as VarianceReason | null,
        approvedAt: d.approvedAt!,
      })),
      shortfalls: shortfalls.map((s) => ({ ...s, label: medicineLabel(s), missing: Number(s.missing), receivedAt: s.receivedAt! })),
    };
  });
}
