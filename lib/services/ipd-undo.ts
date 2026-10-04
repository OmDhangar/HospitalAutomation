import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  auditLogs,
  bedAssignments,
  beds,
  billItems,
  bills,
  careEntries,
  chargeItems,
  encounterPayers,
  encounters,
  medicines,
  patientPayments,
  prescriptionItems,
  wards,
} from '@/lib/db/schema';
import { UNDO_WINDOWS_MS, withinWindow } from '@/lib/domain/undo';
import { transferBed } from '@/lib/services/admissions';
import { billUnbilledEntriesForItemsInTx, postCareEntryLineInTx } from '@/lib/services/ipd-billing';

/**
 * Undo for every staff action in IPD and its set-up (decided 3 Oct 2026).
 *
 * Each function takes back one action — and only while that is still a
 * clean thing to do: within its window (lib/domain/undo.ts), and before
 * anything has been built on it. A bed with a patient's history, an item
 * already on a bill, a stay with entries recorded: those are refused with a
 * sentence saying what to do instead. Records are still never edited; an
 * undone record is voided, closed or cancelled, and the undo is audited.
 *
 * Authorisation is the caller's: the same permission the original action
 * needed.
 */

export class UndoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UndoError';
  }
}

const TOO_LATE = 'This can no longer be undone.';

const audit = (tx: Tx, hospitalId: string, actorUserId: string, action: string, objectType: string, objectId: string | null, metadata?: Record<string, unknown>) =>
  tx.insert(auditLogs).values({ hospitalId, actorUserId, action, objectType, objectId, metadata });

/* ------------------------------------------------------------- set-up */

async function bedsUnusedInTx(tx: Tx, bedIds: readonly string[]): Promise<boolean> {
  if (bedIds.length === 0) return true;
  const [used] = await tx
    .select({ id: bedAssignments.id })
    .from(bedAssignments)
    .where(inArray(bedAssignments.bedId, [...bedIds]))
    .limit(1);
  return !used;
}

/** Takes back "Add ward": the ward and its beds go, if no patient ever used them. */
export async function undoCreateWard(args: { hospitalId: string; wardId: string; actorUserId: string }) {
  await withTenant(args.hospitalId, async (tx) => {
    const [ward] = await tx.select().from(wards).where(eq(wards.id, args.wardId)).for('update');
    if (!ward) throw new UndoError('This ward was already removed.');
    if (!withinWindow(ward.createdAt, UNDO_WINDOWS_MS.settings)) throw new UndoError(TOO_LATE);
    const wardBeds = await tx.select({ id: beds.id }).from(beds).where(eq(beds.wardId, ward.id));
    if (!(await bedsUnusedInTx(tx, wardBeds.map((b) => b.id)))) {
      throw new UndoError('A patient has already used a bed in this ward. Close the ward instead.');
    }
    await tx.delete(wards).where(eq(wards.id, ward.id));
    await audit(tx, args.hospitalId, args.actorUserId, 'undo.ward_created', 'ward', ward.id, { name: ward.name });
  });
}

/** Takes back "Add beds": those beds go, if no patient used them. */
export async function undoAddBeds(args: { hospitalId: string; bedIds: readonly string[]; actorUserId: string }) {
  if (args.bedIds.length === 0) throw new UndoError('Nothing to undo.');
  await withTenant(args.hospitalId, async (tx) => {
    const rows = await tx.select().from(beds).where(inArray(beds.id, [...args.bedIds])).for('update');
    if (rows.length === 0) throw new UndoError('These beds were already removed.');
    if (!rows.every((bed) => withinWindow(bed.createdAt, UNDO_WINDOWS_MS.settings))) throw new UndoError(TOO_LATE);
    if (!(await bedsUnusedInTx(tx, rows.map((b) => b.id)))) {
      throw new UndoError('A patient has already used one of these beds. Take it out of use instead.');
    }
    await tx.delete(beds).where(inArray(beds.id, rows.map((b) => b.id)));
    await audit(tx, args.hospitalId, args.actorUserId, 'undo.beds_added', 'ward', rows[0].wardId, {
      labels: rows.map((b) => b.label),
    });
  });
}

/** True when nothing anywhere refers to this catalogue item yet. */
async function itemUnusedInTx(tx: Tx, kind: 'charge_item' | 'medicine', id: string): Promise<boolean> {
  if (kind === 'charge_item') {
    const [[entry], [line], [ward]] = await Promise.all([
      tx.select({ id: careEntries.id }).from(careEntries).where(eq(careEntries.chargeItemId, id)).limit(1),
      tx.select({ id: billItems.id }).from(billItems).where(eq(billItems.chargeItemId, id)).limit(1),
      tx.select({ id: wards.id }).from(wards).where(eq(wards.dailyChargeItemId, id)).limit(1),
    ]);
    return !entry && !line && !ward;
  }
  const [[entry], [line], [prescribed]] = await Promise.all([
    tx.select({ id: careEntries.id }).from(careEntries).where(eq(careEntries.medicineId, id)).limit(1),
    tx.select({ id: billItems.id }).from(billItems).where(eq(billItems.medicineId, id)).limit(1),
    tx.select({ id: prescriptionItems.id }).from(prescriptionItems).where(eq(prescriptionItems.medicineId, id)).limit(1),
  ]);
  return !entry && !line && !prescribed;
}

async function deleteItemIfUnusedInTx(tx: Tx, kind: 'charge_item' | 'medicine', id: string): Promise<boolean> {
  if (!(await itemUnusedInTx(tx, kind, id))) return false;
  if (kind === 'charge_item') await tx.delete(chargeItems).where(eq(chargeItems.id, id));
  else await tx.delete(medicines).where(eq(medicines.id, id));
  return true;
}

/** Takes back "Add item" / "Add medicine", if nothing used it yet. */
export async function undoCreateItem(args: {
  hospitalId: string;
  kind: 'charge_item' | 'medicine';
  id: string;
  actorUserId: string;
}) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const table = args.kind === 'charge_item' ? chargeItems : medicines;
      const [row] = await tx.select({ id: table.id, createdAt: table.createdAt }).from(table).where(eq(table.id, args.id));
      if (!row) throw new UndoError('It was already removed.');
      if (!withinWindow(row.createdAt, UNDO_WINDOWS_MS.settings)) throw new UndoError(TOO_LATE);
      if (!(await deleteItemIfUnusedInTx(tx, args.kind, args.id))) {
        throw new UndoError('It has already been used. Remove it from the list instead.');
      }
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.item_created', args.kind, args.id);
    },
    { clinical: true },
  );
}

type BatchRow = { action: string; objectType: string; objectId: string | null; metadata: Record<string, unknown> | null; createdAt: Date };

/**
 * Takes back one save of prices — a single edit, "Set prices", a CSV import,
 * or loading a starter list. Prices go back to what they were (unless someone
 * has changed them again since); items the save added go, if unused. Bedside
 * entries billed at the mistaken price since the save are re-billed at the
 * restored one; with no price, they wait unbilled as before.
 */
export async function undoPriceBatch(args: { hospitalId: string; batch: string; actorUserId: string }): Promise<{ restored: number; removed: number }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const rows = (await tx
        .select({
          action: auditLogs.action,
          objectType: auditLogs.objectType,
          objectId: auditLogs.objectId,
          metadata: auditLogs.metadata,
          createdAt: auditLogs.createdAt,
        })
        .from(auditLogs)
        .where(sql`${auditLogs.metadata} ->> 'batch' = ${args.batch}`)) as BatchRow[];
      if (rows.length === 0) throw new UndoError('Nothing to undo.');
      if (rows.some((row) => row.action.startsWith('undo.'))) throw new UndoError('This was already undone.');
      const batchAt = rows.reduce((min, row) => (row.createdAt < min ? row.createdAt : min), rows[0].createdAt);
      if (!withinWindow(batchAt, UNDO_WINDOWS_MS.settings)) throw new UndoError(TOO_LATE);

      const restored = { charge_item: [] as string[], medicine: [] as string[] };
      let removed = 0;
      for (const row of rows) {
        const meta = row.metadata ?? {};
        if (row.action === 'billing.price_changed' && row.objectId && (row.objectType === 'charge_item' || row.objectType === 'medicine')) {
          const table = row.objectType === 'charge_item' ? chargeItems : medicines;
          const [current] = await tx
            .select({ price: table.sellingPricePaise, tax: table.taxRateBp })
            .from(table)
            .where(eq(table.id, row.objectId))
            .for('update');
          // Changed again since: that later change wins.
          if (!current || current.price !== (meta.toPaise ?? null)) continue;
          if (meta.toTaxRateBp !== undefined && current.tax !== meta.toTaxRateBp) continue;
          await tx
            .update(table)
            .set({
              sellingPricePaise: (meta.fromPaise as number | null) ?? null,
              ...(meta.fromTaxRateBp !== undefined ? { taxRateBp: meta.fromTaxRateBp as number } : {}),
              ...(meta.fromUnit !== undefined ? { unit: meta.fromUnit as string } : {}),
              updatedAt: new Date(),
            })
            .where(eq(table.id, row.objectId));
          restored[row.objectType].push(row.objectId);
        } else if (row.action === 'ipd.charge_item_created' && row.objectId) {
          if (await deleteItemIfUnusedInTx(tx, 'charge_item', row.objectId)) removed += 1;
        } else if (row.action === 'ipd.starter_items_added' || row.action === 'medicine.starter_list_added') {
          const kind = row.action === 'ipd.starter_items_added' ? 'charge_item' : 'medicine';
          for (const id of (meta.ids as string[] | undefined) ?? []) {
            if (await deleteItemIfUnusedInTx(tx, kind, id)) removed += 1;
          }
        }
      }

      // Lines billed at the mistaken price since the save: void, then re-bill.
      const restoredItems = [
        ...(restored.charge_item.length ? [inArray(billItems.chargeItemId, restored.charge_item)] : []),
        ...(restored.medicine.length ? [inArray(billItems.medicineId, restored.medicine)] : []),
      ];
      for (const itemFilter of restoredItems) {
        const stale = await tx
          .select({ id: billItems.id })
          .from(billItems)
          .innerJoin(bills, eq(bills.id, billItems.billId))
          .where(
            and(
              itemFilter,
              isNotNull(billItems.careEntryId),
              isNull(billItems.voidedAt),
              eq(bills.status, 'draft'),
              gte(billItems.createdAt, batchAt),
            ),
          );
        if (stale.length > 0) {
          await tx
            .update(billItems)
            .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: 'Price change undone' })
            .where(inArray(billItems.id, stale.map((line) => line.id)));
        }
      }
      await billUnbilledEntriesForItemsInTx(tx, {
        chargeItemIds: restored.charge_item,
        medicineIds: restored.medicine,
        actorUserId: args.actorUserId,
      });

      await audit(tx, args.hospitalId, args.actorUserId, 'undo.prices', 'price_list', null, {
        batch: args.batch,
        restored: restored.charge_item.length + restored.medicine.length,
        removed,
      });
      return { restored: restored.charge_item.length + restored.medicine.length, removed };
    },
    { clinical: true },
  );
}

/* --------------------------------------------------------------- desk */

async function lockAdmission(tx: Tx, admissionId: string) {
  const [row] = await tx.select().from(admissions).where(eq(admissions.id, admissionId)).for('update');
  if (!row) throw new UndoError('Admission not found.');
  return row;
}

async function hasLiveEntriesInTx(tx: Tx, admissionId: string): Promise<boolean> {
  const [entry] = await tx
    .select({ id: careEntries.id })
    .from(careEntries)
    .where(and(eq(careEntries.admissionId, admissionId), isNull(careEntries.voidedAt)))
    .limit(1);
  return Boolean(entry);
}

/**
 * Removes a stay's bed history and the room lines posted for it — only used
 * when that history is minutes old and is itself the mistake being undone.
 * Room lines on a draft bill are deleted rather than voided, because they
 * hold the bed assignment in place and were never a charge anyone saw.
 */
async function eraseBedsInTx(tx: Tx, admissionId: string) {
  const spells = await tx.select({ id: bedAssignments.id }).from(bedAssignments).where(eq(bedAssignments.admissionId, admissionId));
  if (spells.length === 0) return;
  const ids = spells.map((spell) => spell.id);
  await tx.delete(billItems).where(inArray(billItems.bedAssignmentId, ids));
  await tx.delete(bedAssignments).where(inArray(bedAssignments.id, ids));
}

async function voidDepositInTx(tx: Tx, encounterId: string, depositId: string | null, actorUserId: string) {
  if (!depositId) return;
  await tx
    .update(patientPayments)
    .set({ voidedAt: new Date(), voidedByUserId: actorUserId, voidReason: 'Admission undone' })
    .where(and(eq(patientPayments.id, depositId), eq(patientPayments.encounterId, encounterId), isNull(patientPayments.voidedAt)));
}

/** Takes back "Confirm bed": the patient returns to Awaiting bed, the deposit is voided. */
export async function undoAssignBed(args: { hospitalId: string; admissionId: string; depositId: string | null; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmission(tx, args.admissionId);
      if (admission.status !== 'admitted' || !withinWindow(admission.admittedAt, UNDO_WINDOWS_MS.desk)) {
        throw new UndoError(TOO_LATE);
      }
      if (await hasLiveEntriesInTx(tx, admission.id)) {
        throw new UndoError('Something has already been recorded for this patient. Use Transfer to change the bed.');
      }
      const spells = await tx.select({ id: bedAssignments.id }).from(bedAssignments).where(eq(bedAssignments.admissionId, admission.id));
      if (spells.length > 1) throw new UndoError('The patient has been moved since. Use Transfer.');
      await eraseBedsInTx(tx, admission.id);
      await tx
        .update(admissions)
        .set({ status: 'awaiting_bed', admittedAt: null, admittedByUserId: null, updatedAt: new Date() })
        .where(eq(admissions.id, admission.id));
      await voidDepositInTx(tx, admission.encounterId, args.depositId, args.actorUserId);
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.bed_assigned', 'admission', admission.id);
    },
    { clinical: true },
  );
}

/** Takes back a transfer: back to the previous bed, if it is still free. */
export async function undoTransfer(args: { hospitalId: string; admissionId: string; previousBedId: string; actorUserId: string }) {
  const latest = await withTenant(
    args.hospitalId,
    async (tx) => {
      const [spell] = await tx
        .select({ fromAt: bedAssignments.fromAt })
        .from(bedAssignments)
        .where(and(eq(bedAssignments.admissionId, args.admissionId), isNull(bedAssignments.toAt)));
      return spell ?? null;
    },
    { clinical: true },
  );
  if (!latest || !withinWindow(latest.fromAt, UNDO_WINDOWS_MS.desk)) throw new UndoError(TOO_LATE);
  await transferBed({ hospitalId: args.hospitalId, admissionId: args.admissionId, bedId: args.previousBedId, actorUserId: args.actorUserId });
}

/** Takes back an emergency admission made by mistake: nothing of it stays live. */
export async function undoDirectAdmission(args: { hospitalId: string; admissionId: string; depositId: string | null; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmission(tx, args.admissionId);
      const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, admission.encounterId)).for('update');
      if (
        encounter.origin === 'queue' ||
        (admission.status !== 'awaiting_bed' && admission.status !== 'admitted') ||
        !withinWindow(admission.requestedAt, UNDO_WINDOWS_MS.desk)
      ) {
        throw new UndoError(TOO_LATE);
      }
      if (await hasLiveEntriesInTx(tx, admission.id)) {
        throw new UndoError('Something has already been recorded for this patient. Cancel is no longer possible.');
      }
      await eraseBedsInTx(tx, admission.id);
      const now = new Date();
      await tx
        .update(admissions)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          cancelledByUserId: args.actorUserId,
          cancelReason: 'Admission undone',
          admittedAt: admission.admittedAt,
          updatedAt: now,
        })
        .where(eq(admissions.id, admission.id));
      await voidDepositInTx(tx, admission.encounterId, args.depositId, args.actorUserId);
      if (encounter.status === 'open') {
        await tx.update(encounters).set({ status: 'cancelled', closedAt: now, updatedAt: now }).where(eq(encounters.id, encounter.id));
      }
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.admitted_direct', 'admission', admission.id);
    },
    { clinical: true },
  );
}

/** Takes back "Cancel admission": the patient is back on Awaiting bed. */
export async function undoCancelAdmission(args: { hospitalId: string; admissionId: string; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmission(tx, args.admissionId);
      if (admission.status !== 'cancelled' || !withinWindow(admission.cancelledAt, UNDO_WINDOWS_MS.desk)) {
        throw new UndoError(TOO_LATE);
      }
      const [other] = await tx
        .select({ id: admissions.id })
        .from(admissions)
        .where(and(eq(admissions.encounterId, admission.encounterId), sql`${admissions.status} <> 'cancelled'`));
      if (other) throw new UndoError('This visit has been admitted again since.');
      const now = new Date();
      await tx
        .update(admissions)
        .set({ status: 'awaiting_bed', cancelledAt: null, cancelledByUserId: null, cancelReason: null, admittedAt: null, updatedAt: now })
        .where(eq(admissions.id, admission.id));
      await tx
        .update(encounters)
        .set({ stage: 'ipd', status: 'open', closedAt: null, updatedAt: now })
        .where(eq(encounters.id, admission.encounterId));
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.admission_cancelled', 'admission', admission.id);
    },
    { clinical: true },
  );
}

/** Copies a voided entry back as a new, live one (records are never un-voided). */
async function restoreEntryInTx(tx: Tx, entryId: string) {
  const [old] = await tx.select().from(careEntries).where(eq(careEntries.id, entryId));
  if (!old?.voidedAt) throw new UndoError('This entry is not removed.');
  const [admission] = await tx.select({ status: admissions.status }).from(admissions).where(eq(admissions.id, old.admissionId));
  if (admission?.status !== 'admitted' && admission?.status !== 'discharge_ready') {
    throw new UndoError('This stay is no longer open.');
  }
  const [copy] = await tx
    .insert(careEntries)
    .values({
      hospitalId: old.hospitalId,
      admissionId: old.admissionId,
      encounterId: old.encounterId,
      patientId: old.patientId,
      medicineId: old.medicineId,
      chargeItemId: old.chargeItemId,
      description: old.description,
      quantity: old.quantity,
      occurredAt: old.occurredAt,
      recordedByUserId: old.recordedByUserId,
      clientId: crypto.randomUUID(),
    })
    .returning();
  return { old, copy };
}

/** Takes back the desk's "Remove entry": the entry and its bill line come back. */
export async function undoVoidCareEntry(args: { hospitalId: string; entryId: string; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [entry] = await tx.select({ voidedAt: careEntries.voidedAt }).from(careEntries).where(eq(careEntries.id, args.entryId));
      if (!entry || !withinWindow(entry.voidedAt, UNDO_WINDOWS_MS.desk)) throw new UndoError(TOO_LATE);
      const { copy } = await restoreEntryInTx(tx, args.entryId);
      await postCareEntryLineInTx(tx, { entry: copy, actorUserId: args.actorUserId });
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.care_entry_voided', 'care_entry', args.entryId, { restoredAs: copy.id });
    },
    { clinical: true },
  );
}

/* --------------------------------------------------------------- bill */

async function draftBillOf(tx: Tx, billId: string) {
  const [bill] = await tx.select({ status: bills.status }).from(bills).where(eq(bills.id, billId));
  if (bill?.status !== 'draft') throw new UndoError('The bill is final. Reopen it first.');
}

const copyOfLine = (line: typeof billItems.$inferSelect) => ({
  hospitalId: line.hospitalId,
  billId: line.billId,
  itemType: line.itemType,
  serviceId: line.serviceId,
  appointmentId: line.appointmentId,
  medicineId: line.medicineId,
  chargeItemId: line.chargeItemId,
  careEntryId: line.careEntryId,
  bedAssignmentId: line.bedAssignmentId,
  serviceDate: line.serviceDate,
  description: line.description,
  quantity: line.quantity,
  configuredUnitPricePaise: line.configuredUnitPricePaise,
  unitPricePaise: line.unitPricePaise,
  priceOverrideReason: line.priceOverrideReason,
  subtotalPaise: line.subtotalPaise,
  discountPaise: line.discountPaise,
  discountReason: line.discountReason,
  taxRateBp: line.taxRateBp,
  taxPaise: line.taxPaise,
  totalPaise: line.totalPaise,
});

/** Takes back "Remove line": the line (and its bedside entry) come back as they were. */
export async function undoVoidBillLine(args: { hospitalId: string; lineId: string; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [line] = await tx.select().from(billItems).where(eq(billItems.id, args.lineId));
      if (!line || !withinWindow(line.voidedAt, UNDO_WINDOWS_MS.desk)) throw new UndoError(TOO_LATE);
      await draftBillOf(tx, line.billId);
      let careEntryId = line.careEntryId;
      if (line.careEntryId) {
        const [entry] = await tx.select({ voidedAt: careEntries.voidedAt }).from(careEntries).where(eq(careEntries.id, line.careEntryId));
        if (entry?.voidedAt) careEntryId = (await restoreEntryInTx(tx, line.careEntryId)).copy.id;
      }
      await tx.insert(billItems).values({ ...copyOfLine(line), careEntryId, createdByUserId: args.actorUserId });
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.line_voided', 'bill_item', line.id);
    },
    { clinical: true },
  );
}

/** Takes back a discount: the discounted line is replaced by the full one. */
export async function undoDiscount(args: { hospitalId: string; lineId: string; actorUserId: string }) {
  await withTenant(args.hospitalId, async (tx) => {
    const [line] = await tx.select().from(billItems).where(eq(billItems.id, args.lineId)).for('update');
    if (!line || line.voidedAt || line.discountPaise === 0 || !withinWindow(line.createdAt, UNDO_WINDOWS_MS.desk)) {
      throw new UndoError(TOO_LATE);
    }
    await draftBillOf(tx, line.billId);
    await tx
      .update(billItems)
      .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: 'Discount undone' })
      .where(eq(billItems.id, line.id));
    const subtotal = line.quantity * line.unitPricePaise;
    const tax = Math.round((subtotal * line.taxRateBp) / 10_000);
    await tx.insert(billItems).values({
      ...copyOfLine(line),
      subtotalPaise: subtotal,
      discountPaise: 0,
      discountReason: null,
      taxPaise: tax,
      totalPaise: subtotal + tax,
      createdByUserId: args.actorUserId,
    });
    await audit(tx, args.hospitalId, args.actorUserId, 'undo.line_discounted', 'bill_item', line.id);
  });
}

/** Takes back a payment or refund entered by mistake: it is voided. */
export async function undoPayment(args: { hospitalId: string; paymentId: string; actorUserId: string }) {
  await withTenant(args.hospitalId, async (tx) => {
    const [payment] = await tx.select().from(patientPayments).where(eq(patientPayments.id, args.paymentId)).for('update');
    if (!payment || payment.voidedAt || !withinWindow(payment.createdAt, UNDO_WINDOWS_MS.desk)) throw new UndoError(TOO_LATE);
    await tx
      .update(patientPayments)
      .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: 'Entered by mistake (undone)' })
      .where(eq(patientPayments.id, payment.id));
    await audit(tx, args.hospitalId, args.actorUserId, 'undo.payment', 'patient_payment', payment.id, { amountPaise: payment.amountPaise });
  });
}

/** Takes back an approved amount: the payer goes back to what it was. */
export async function undoApprovedAmount(args: { hospitalId: string; admissionId: string; actorUserId: string }) {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const [admission] = await tx.select({ encounterId: admissions.encounterId }).from(admissions).where(eq(admissions.id, args.admissionId));
      if (!admission) throw new UndoError('Admission not found.');
      const [active] = await tx
        .select()
        .from(encounterPayers)
        .where(and(eq(encounterPayers.encounterId, admission.encounterId), isNull(encounterPayers.voidedAt)))
        .for('update');
      if (!active || !withinWindow(active.createdAt, UNDO_WINDOWS_MS.desk)) throw new UndoError(TOO_LATE);
      const [previous] = await tx
        .select()
        .from(encounterPayers)
        .where(and(eq(encounterPayers.encounterId, admission.encounterId), isNotNull(encounterPayers.voidedAt)))
        .orderBy(desc(encounterPayers.voidedAt))
        .limit(1);
      if (!previous) throw new UndoError('There is no earlier payer to go back to.');
      await tx
        .update(encounterPayers)
        .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: 'Undone' })
        .where(eq(encounterPayers.id, active.id));
      await tx.insert(encounterPayers).values({
        hospitalId: previous.hospitalId,
        encounterId: previous.encounterId,
        patientId: previous.patientId,
        kind: previous.kind,
        payerName: previous.payerName,
        policyNumber: previous.policyNumber,
        preauthAmountPaise: previous.preauthAmountPaise,
        approvedAmountPaise: previous.approvedAmountPaise,
        createdByUserId: args.actorUserId,
      });
      await audit(tx, args.hospitalId, args.actorUserId, 'undo.approved_amount', 'encounter', admission.encounterId);
    },
    { clinical: true },
  );
}

/**
 * Reopens a finalised bill, within a day, with a reason. The numbered bill is
 * kept, cancelled — its number stays used, so numbering stays gap-free — and
 * its lines are posted again on a new draft. The patient is back on the
 * Discharge ready list, in their bed if it is still free.
 */
export async function reopenDischarge(args: { hospitalId: string; admissionId: string; reason: string; actorUserId: string }) {
  const reason = args.reason.trim().slice(0, 160);
  if (!reason) throw new UndoError('Say why the bill is reopened.');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const admission = await lockAdmission(tx, args.admissionId);
      if (admission.status !== 'discharged' || !withinWindow(admission.dischargedAt, UNDO_WINDOWS_MS.reopenBill)) {
        throw new UndoError('A bill can be reopened only on the day of discharge. Make a correction bill instead.');
      }
      const [bill] = await tx
        .select()
        .from(bills)
        .where(and(eq(bills.encounterId, admission.encounterId), eq(bills.status, 'final')))
        .for('update');
      if (!bill) throw new UndoError('No final bill found for this stay.');
      const now = new Date();

      await tx
        .update(bills)
        .set({ status: 'cancelled', cancelledAt: now, cancelledByUserId: args.actorUserId, cancelReason: `Reopened: ${reason}`, updatedAt: now })
        .where(eq(bills.id, bill.id));
      const lines = await tx
        .select()
        .from(billItems)
        .where(and(eq(billItems.billId, bill.id), isNull(billItems.voidedAt)));
      if (lines.length > 0) {
        await tx
          .update(billItems)
          .set({ voidedAt: now, voidedByUserId: args.actorUserId, voidReason: 'Bill reopened' })
          .where(inArray(billItems.id, lines.map((line) => line.id)));
      }
      const [draft] = await tx
        .insert(bills)
        .values({
          hospitalId: bill.hospitalId,
          encounterId: bill.encounterId,
          patientId: bill.patientId,
          supersedesBillId: bill.id,
          createdByUserId: args.actorUserId,
        })
        .returning({ id: bills.id });
      if (lines.length > 0) {
        await tx.insert(billItems).values(lines.map((line) => ({ ...copyOfLine(line), billId: draft.id, createdByUserId: args.actorUserId })));
      }

      await tx
        .update(admissions)
        .set({
          status: admission.dischargeReadyAt ? 'discharge_ready' : 'admitted',
          dischargedAt: null,
          dischargedByUserId: null,
          billLinkExpiresAt: null,
          updatedAt: now,
        })
        .where(eq(admissions.id, admission.id));
      await tx.update(encounters).set({ status: 'open', closedAt: null, updatedAt: now }).where(eq(encounters.id, admission.encounterId));

      // Back into the same bed, if nobody has taken it.
      const [last] = await tx
        .select({ bedId: bedAssignments.bedId })
        .from(bedAssignments)
        .where(eq(bedAssignments.admissionId, admission.id))
        .orderBy(desc(bedAssignments.fromAt))
        .limit(1);
      if (last) {
        const [taken] = await tx
          .select({ id: bedAssignments.id })
          .from(bedAssignments)
          .where(and(eq(bedAssignments.bedId, last.bedId), isNull(bedAssignments.toAt)));
        if (!taken) {
          await tx.insert(bedAssignments).values({
            hospitalId: admission.hospitalId,
            admissionId: admission.id,
            bedId: last.bedId,
            fromAt: now,
            assignedByUserId: args.actorUserId,
          });
        }
      }
      await audit(tx, args.hospitalId, args.actorUserId, 'billing.bill_reopened', 'bill', bill.id, { reason, billNumber: bill.billNumber });
    },
    { clinical: true },
  );
}
