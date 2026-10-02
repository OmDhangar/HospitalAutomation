import { and, eq, inArray, isNull, notExists, or, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import {
  admissions,
  billItems,
  careEntries,
  chargeItems,
  encounters,
  medicines,
} from '@/lib/db/schema';
import { calculateBillItem } from '@/lib/domain/patient-billing';
import { getOrCreateDraftBillInTx } from '@/lib/services/patient-billing';

/**
 * Turns bedside entries into bill lines (IPD plan §T1.7, reversing D20).
 *
 * The price is read here, from the catalogue, inside the transaction that
 * charges it. The phone never sends one. An unpriced item still produces a
 * care entry, just no line yet; the line is posted when the owner prices the
 * item, by `billUnbilledEntriesForItemsInTx`.
 *
 * Every function takes a transaction that has the clinical key, because care
 * entries and admissions are clinical tables.
 */

type CareEntryRow = typeof careEntries.$inferSelect;

/** Admissions whose entries may still be billed: the stay is not over. */
export const BILLABLE_ADMISSION_STATUSES = ['admitted', 'discharge_ready'] as const;

type CatalogueItem = {
  itemType: 'medicine' | 'consumable' | 'procedure' | 'service' | 'room';
  medicineId: string | null;
  chargeItemId: string | null;
  sellingPricePaise: number | null;
  taxRateBp: number;
};

async function catalogueItemFor(tx: Tx, entry: CareEntryRow): Promise<CatalogueItem | null> {
  if (entry.medicineId) {
    const [row] = await tx
      .select({ price: medicines.sellingPricePaise, tax: medicines.taxRateBp })
      .from(medicines)
      .where(eq(medicines.id, entry.medicineId));
    if (!row) return null;
    return {
      itemType: 'medicine',
      medicineId: entry.medicineId,
      chargeItemId: null,
      sellingPricePaise: row.price,
      taxRateBp: row.tax,
    };
  }
  if (entry.chargeItemId) {
    const [row] = await tx
      .select({ kind: chargeItems.kind, price: chargeItems.sellingPricePaise, tax: chargeItems.taxRateBp })
      .from(chargeItems)
      .where(eq(chargeItems.id, entry.chargeItemId));
    if (!row) return null;
    return {
      itemType: row.kind,
      medicineId: null,
      chargeItemId: entry.chargeItemId,
      sellingPricePaise: row.price,
      taxRateBp: row.tax,
    };
  }
  return null;
}

/**
 * Posts the bill line for one care entry, at the catalogue's current price.
 *
 * Returns false, and posts nothing, when the item has no price yet. Posting
 * twice is an insert that does nothing (bill_items_care_entry_once), so a
 * retried request or a re-run back-fill never charges twice.
 */
export async function postCareEntryLineInTx(
  tx: Tx,
  args: { entry: CareEntryRow; actorUserId: string | null },
): Promise<boolean> {
  const item = await catalogueItemFor(tx, args.entry);
  if (!item || item.sellingPricePaise === null) return false;

  const [encounter] = await tx
    .select()
    .from(encounters)
    .where(eq(encounters.id, args.entry.encounterId));
  if (!encounter) return false;

  const bill = await getOrCreateDraftBillInTx(tx, { encounter, actorUserId: args.actorUserId });
  const amounts = calculateBillItem({
    quantity: args.entry.quantity,
    unitPricePaise: item.sellingPricePaise,
    taxRateBp: item.taxRateBp,
  });

  const inserted = await tx
    .insert(billItems)
    .values({
      hospitalId: args.entry.hospitalId,
      billId: bill.id,
      itemType: item.itemType,
      medicineId: item.medicineId,
      chargeItemId: item.chargeItemId,
      careEntryId: args.entry.id,
      description: args.entry.description,
      quantity: args.entry.quantity,
      configuredUnitPricePaise: item.sellingPricePaise,
      unitPricePaise: item.sellingPricePaise,
      taxRateBp: item.taxRateBp,
      ...amounts,
      createdByUserId: args.actorUserId,
    })
    .onConflictDoNothing({
      target: billItems.careEntryId,
      where: sql`care_entry_id is not null and voided_at is null`,
    })
    .returning({ id: billItems.id });
  return inserted.length > 0;
}

/**
 * Voids the live bill line of a care entry, if it has one, with the same
 * reason. The line is never deleted: the bill shows it struck through.
 */
export async function voidCareEntryLineInTx(
  tx: Tx,
  args: { careEntryId: string; actorUserId: string; reason: string },
): Promise<void> {
  await tx
    .update(billItems)
    .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: args.reason })
    .where(and(eq(billItems.careEntryId, args.careEntryId), isNull(billItems.voidedAt)));
}

/**
 * After an owner prices items: bills every live entry of those items that has
 * no line yet, on stays that are still open. Called in the same transaction
 * as the price change, so "priced" and "billed" never disagree.
 *
 * Entries of a stay already discharged are left alone; reopening a final bill
 * is a correction for the desk, not a side effect of editing a price.
 */
export async function billUnbilledEntriesForItemsInTx(
  tx: Tx,
  args: { medicineIds?: readonly string[]; chargeItemIds?: readonly string[]; actorUserId: string },
): Promise<number> {
  const medicineIds = [...(args.medicineIds ?? [])];
  const chargeItemIds = [...(args.chargeItemIds ?? [])];
  if (medicineIds.length === 0 && chargeItemIds.length === 0) return 0;

  const itemFilter = or(
    medicineIds.length > 0 ? inArray(careEntries.medicineId, medicineIds) : undefined,
    chargeItemIds.length > 0 ? inArray(careEntries.chargeItemId, chargeItemIds) : undefined,
  );

  const pending = await tx
    .select({ entry: careEntries })
    .from(careEntries)
    .innerJoin(admissions, eq(admissions.id, careEntries.admissionId))
    .where(
      and(
        itemFilter,
        isNull(careEntries.voidedAt),
        inArray(admissions.status, [...BILLABLE_ADMISSION_STATUSES]),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(billItems)
            .where(and(eq(billItems.careEntryId, careEntries.id), isNull(billItems.voidedAt))),
        ),
      ),
    )
    .orderBy(careEntries.occurredAt);

  let posted = 0;
  for (const { entry } of pending) {
    if (await postCareEntryLineInTx(tx, { entry, actorUserId: args.actorUserId })) posted += 1;
  }
  return posted;
}
