import { and, asc, eq, inArray, isNull, max, sql, type SQL } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  auditLogs,
  bedAssignments,
  beds,
  branches,
  chargeItems,
  wards,
} from '@/lib/db/schema';
import {
  compareBedLabels,
  parseBedLabels,
  parseChargeItemInput,
  type ChargeItemKind,
  type CsvImportRow,
  type PriceEdit,
} from '@/lib/domain/ipd-config';
import { escapeLikePattern, tidy } from '@/lib/domain/medicine';
import { STARTER_CHARGE_ITEMS } from '@/lib/domain/starter-charge-items';
import { billUnbilledEntriesForItemsInTx } from '@/lib/services/ipd-billing';

/**
 * IPD set-up: wards, beds and the non-medicine price list (IPD plan §5.7,
 * §5.8, task T1.3).
 *
 * Configuration, not patient data, so most of this runs without the clinical
 * key. The exception is pricing: setting a price also bills the bedside
 * entries that were waiting for it, and those are clinical rows.
 *
 * Authorisation is the caller's: `ipd.configure` for wards and beds,
 * `billing.price` for prices.
 */

export class IpdConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpdConfigError';
  }
}

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean => {
  for (let e = err as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === UNIQUE_VIOLATION) return true;
  }
  return false;
};

/* ------------------------------------------------------------ wards, beds */

export type BedSetupRow = {
  id: string;
  label: string;
  active: boolean;
  occupied: boolean;
};

export type WardSetupRow = {
  id: string;
  branchId: string;
  branchName: string;
  name: string;
  active: boolean;
  dailyChargeItemId: string | null;
  dailyChargeName: string | null;
  dailyChargePaise: number | null;
  beds: BedSetupRow[];
};

/** Every ward with its beds, for the settings screen. */
export async function listWardSetup(hospitalId: string): Promise<WardSetupRow[]> {
  return withTenant(hospitalId, async (tx) => {
    const [wardRows, bedRows, occupied] = await Promise.all([
      tx
        .select({
          id: wards.id,
          branchId: wards.branchId,
          branchName: branches.name,
          name: wards.name,
          active: wards.active,
          dailyChargeItemId: wards.dailyChargeItemId,
          dailyChargeName: chargeItems.name,
          dailyChargePaise: chargeItems.sellingPricePaise,
          sortOrder: wards.sortOrder,
        })
        .from(wards)
        .innerJoin(branches, eq(branches.id, wards.branchId))
        .leftJoin(chargeItems, eq(chargeItems.id, wards.dailyChargeItemId))
        .orderBy(asc(wards.sortOrder), asc(wards.name)),
      tx
        .select({ id: beds.id, wardId: beds.wardId, label: beds.label, active: beds.active })
        .from(beds),
      tx
        .select({ bedId: bedAssignments.bedId })
        .from(bedAssignments)
        .where(isNull(bedAssignments.toAt)),
    ]);

    const occupiedIds = new Set(occupied.map((row) => row.bedId));
    return wardRows.map((ward) => ({
      id: ward.id,
      branchId: ward.branchId,
      branchName: ward.branchName,
      name: ward.name,
      active: ward.active,
      dailyChargeItemId: ward.dailyChargeItemId,
      dailyChargeName: ward.dailyChargeName,
      dailyChargePaise: ward.dailyChargePaise,
      beds: bedRows
        .filter((bed) => bed.wardId === ward.id)
        .sort((a, b) => compareBedLabels(a.label, b.label))
        .map((bed) => ({
          id: bed.id,
          label: bed.label,
          active: bed.active,
          occupied: occupiedIds.has(bed.id),
        })),
    }));
  });
}

async function assertRoomItemInTx(tx: Tx, chargeItemId: string | null): Promise<void> {
  if (!chargeItemId) return;
  const [item] = await tx
    .select({ kind: chargeItems.kind })
    .from(chargeItems)
    .where(eq(chargeItems.id, chargeItemId));
  if (!item) throw new IpdConfigError('Room charge not found');
  if (item.kind !== 'room') throw new IpdConfigError('Pick a room charge (per day) for the ward');
}

/**
 * Creates a ward and, optionally, its beds in one go: "Ward A, beds 1-12" is
 * the whole job for most wards.
 */
export async function createWard(args: {
  hospitalId: string;
  branchId: string;
  name: string;
  dailyChargeItemId: string | null;
  bedLabels?: string;
  actorUserId: string;
}): Promise<{ wardId: string; bedsAdded: number }> {
  const name = tidy(args.name);
  if (!name || name.length > 60) throw new IpdConfigError('Enter a ward name (up to 60 characters)');
  const labels = args.bedLabels?.trim() ? parseBedLabels(args.bedLabels) : null;
  if (labels && !labels.ok) throw new IpdConfigError(labels.error);

  try {
    return await withTenant(args.hospitalId, async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id })
        .from(branches)
        .where(eq(branches.id, args.branchId));
      if (!branch) throw new IpdConfigError('Branch not found');
      await assertRoomItemInTx(tx, args.dailyChargeItemId);

      const [{ next }] = await tx
        .select({ next: sql<number>`coalesce(max(${wards.sortOrder}), -1)::int + 1` })
        .from(wards);
      const [ward] = await tx
        .insert(wards)
        .values({
          hospitalId: args.hospitalId,
          branchId: branch.id,
          name,
          sortOrder: next,
          dailyChargeItemId: args.dailyChargeItemId,
        })
        .returning({ id: wards.id });

      const bedsAdded = labels?.ok ? await insertBedsInTx(tx, args.hospitalId, ward.id, labels.value) : 0;
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'ipd.ward_created',
        objectType: 'ward',
        objectId: ward.id,
        metadata: { name, bedsAdded },
      });
      return { wardId: ward.id, bedsAdded };
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new IpdConfigError(`There is already a ward called ${name}`);
    throw err;
  }
}

export async function updateWard(args: {
  hospitalId: string;
  wardId: string;
  name: string;
  dailyChargeItemId: string | null;
  actorUserId: string;
}): Promise<void> {
  const name = tidy(args.name);
  if (!name || name.length > 60) throw new IpdConfigError('Enter a ward name (up to 60 characters)');
  try {
    await withTenant(args.hospitalId, async (tx) => {
      await assertRoomItemInTx(tx, args.dailyChargeItemId);
      const [row] = await tx
        .update(wards)
        .set({ name, dailyChargeItemId: args.dailyChargeItemId, updatedAt: new Date() })
        .where(eq(wards.id, args.wardId))
        .returning({ id: wards.id });
      if (!row) throw new IpdConfigError('Ward not found');
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'ipd.ward_updated',
        objectType: 'ward',
        objectId: row.id,
        metadata: { name, dailyChargeItemId: args.dailyChargeItemId },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new IpdConfigError(`There is already a ward called ${name}`);
    throw err;
  }
}

/** A ward with a patient in it cannot be closed; move them first. */
export async function setWardActive(args: {
  hospitalId: string;
  wardId: string;
  active: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    if (!args.active) {
      const [busy] = await tx
        .select({ id: bedAssignments.id })
        .from(bedAssignments)
        .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
        .where(and(eq(beds.wardId, args.wardId), isNull(bedAssignments.toAt)))
        .limit(1);
      if (busy) throw new IpdConfigError('Someone is in a bed in this ward. Move them first.');
    }
    const [row] = await tx
      .update(wards)
      .set({ active: args.active, updatedAt: new Date() })
      .where(eq(wards.id, args.wardId))
      .returning({ id: wards.id });
    if (!row) throw new IpdConfigError('Ward not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active ? 'ipd.ward_activated' : 'ipd.ward_deactivated',
      objectType: 'ward',
      objectId: row.id,
    });
  });
}

async function insertBedsInTx(
  tx: Tx,
  hospitalId: string,
  wardId: string,
  labels: readonly string[],
): Promise<number> {
  if (labels.length === 0) return 0;
  const [{ top }] = await tx
    .select({ top: max(beds.sortOrder) })
    .from(beds)
    .where(eq(beds.wardId, wardId));
  const start = (top ?? -1) + 1;
  const inserted = await tx
    .insert(beds)
    .values(
      [...labels]
        .sort(compareBedLabels)
        .map((label, index) => ({ hospitalId, wardId, label, sortOrder: start + index })),
    )
    .onConflictDoNothing()
    .returning({ id: beds.id });
  return inserted.length;
}

/** "1-12" → twelve beds. Labels already in the ward are skipped, not errors. */
export async function addBeds(args: {
  hospitalId: string;
  wardId: string;
  labels: string;
  actorUserId: string;
}): Promise<{ added: number; skipped: number }> {
  const parsed = parseBedLabels(args.labels);
  if (!parsed.ok) throw new IpdConfigError(parsed.error);
  return withTenant(args.hospitalId, async (tx) => {
    const [ward] = await tx.select({ id: wards.id }).from(wards).where(eq(wards.id, args.wardId));
    if (!ward) throw new IpdConfigError('Ward not found');
    const added = await insertBedsInTx(tx, args.hospitalId, ward.id, parsed.value);
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'ipd.beds_added',
      objectType: 'ward',
      objectId: ward.id,
      metadata: { added, requested: parsed.value.length },
    });
    return { added, skipped: parsed.value.length - added };
  });
}

/**
 * Beds are never deleted once they exist: a bed with history is part of a
 * past bill. Deactivating hides it from the grid; an occupied bed refuses.
 */
export async function setBedActive(args: {
  hospitalId: string;
  bedId: string;
  active: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    if (!args.active) {
      const [busy] = await tx
        .select({ id: bedAssignments.id })
        .from(bedAssignments)
        .where(and(eq(bedAssignments.bedId, args.bedId), isNull(bedAssignments.toAt)));
      if (busy) throw new IpdConfigError('Someone is in this bed. Move them first.');
    }
    const [row] = await tx
      .update(beds)
      .set({ active: args.active })
      .where(eq(beds.id, args.bedId))
      .returning({ id: beds.id, label: beds.label });
    if (!row) throw new IpdConfigError('Bed not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active ? 'ipd.bed_activated' : 'ipd.bed_deactivated',
      objectType: 'bed',
      objectId: row.id,
      metadata: { label: row.label },
    });
  });
}

/* ----------------------------------------------------------- charge items */

export type ChargeItemRow = {
  id: string;
  kind: ChargeItemKind;
  name: string;
  unit: string;
  sellingPricePaise: number | null;
  taxRateBp: number;
  isTest: boolean;
  active: boolean;
};

export type ChargeItemFilter = 'all' | 'unpriced' | 'inactive';

const chargeItemColumns = {
  id: chargeItems.id,
  kind: chargeItems.kind,
  name: chargeItems.name,
  unit: chargeItems.unit,
  sellingPricePaise: chargeItems.sellingPricePaise,
  taxRateBp: chargeItems.taxRateBp,
  isTest: chargeItems.isTest,
  active: chargeItems.active,
};

/** The owner's price list screen. */
export async function listChargeItems(args: {
  hospitalId: string;
  query?: string;
  filter?: ChargeItemFilter;
  kind?: ChargeItemKind | null;
}): Promise<{ rows: ChargeItemRow[]; counts: { total: number; unpriced: number; inactive: number } }> {
  const filter = args.filter ?? 'all';
  const term = tidy(args.query ?? '').toLowerCase();

  return withTenant(args.hospitalId, async (tx) => {
    const conditions: SQL[] = [];
    if (term) conditions.push(sql`lower(${chargeItems.name}) like ${`%${escapeLikePattern(term)}%`}`);
    if (args.kind) conditions.push(eq(chargeItems.kind, args.kind));
    if (filter === 'unpriced') {
      conditions.push(isNull(chargeItems.sellingPricePaise), eq(chargeItems.active, true));
    } else if (filter === 'inactive') {
      conditions.push(eq(chargeItems.active, false));
    } else {
      conditions.push(eq(chargeItems.active, true));
    }

    const [rows, [counts]] = await Promise.all([
      tx
        .select(chargeItemColumns)
        .from(chargeItems)
        .where(and(...conditions))
        .orderBy(asc(chargeItems.kind), asc(sql`lower(${chargeItems.name})`))
        .limit(500),
      tx
        .select({
          total: sql<number>`count(*) filter (where ${chargeItems.active})::int`,
          unpriced: sql<number>`count(*) filter (where ${chargeItems.active} and ${chargeItems.sellingPricePaise} is null)::int`,
          inactive: sql<number>`count(*) filter (where not ${chargeItems.active})::int`,
        })
        .from(chargeItems),
    ]);
    return { rows, counts };
  });
}

/** Room charges, for the ward form's "room charge per day" choice. */
export async function listRoomChargeItems(hospitalId: string): Promise<ChargeItemRow[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select(chargeItemColumns)
      .from(chargeItems)
      .where(and(eq(chargeItems.kind, 'room'), eq(chargeItems.active, true)))
      .orderBy(asc(chargeItems.name)),
  );
}

export async function createChargeItem(args: {
  hospitalId: string;
  input: unknown;
  actorUserId: string;
}): Promise<{ id: string }> {
  const parsed = parseChargeItemInput(args.input);
  if (!parsed.ok) throw new IpdConfigError(parsed.error);
  try {
    return await withTenant(args.hospitalId, async (tx) => {
      const [row] = await tx
        .insert(chargeItems)
        .values({ hospitalId: args.hospitalId, ...parsed.value, createdByUserId: args.actorUserId })
        .returning({ id: chargeItems.id });
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'ipd.charge_item_created',
        objectType: 'charge_item',
        objectId: row.id,
        metadata: { name: parsed.value.name, kind: parsed.value.kind, sellingPricePaise: parsed.value.sellingPricePaise },
      });
      return row;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new IpdConfigError(`${parsed.value.name} is already in the price list`);
    throw err;
  }
}

/**
 * Edits an item. A price change is audited with both amounts (the price
 * history) and bills the entries that were waiting for a price. Bill lines
 * already posted keep the price they were charged at.
 */
export async function updateChargeItem(args: {
  hospitalId: string;
  chargeItemId: string;
  input: unknown;
  actorUserId: string;
}): Promise<{ billed: number }> {
  const parsed = parseChargeItemInput(args.input);
  if (!parsed.ok) throw new IpdConfigError(parsed.error);
  try {
    return await withTenant(
      args.hospitalId,
      async (tx) => {
        const [before] = await tx
          .select()
          .from(chargeItems)
          .where(eq(chargeItems.id, args.chargeItemId))
          .for('update');
        if (!before) throw new IpdConfigError('Item not found');
        await tx
          .update(chargeItems)
          .set({ ...parsed.value, updatedAt: new Date() })
          .where(eq(chargeItems.id, before.id));

        const priceChanged =
          before.sellingPricePaise !== parsed.value.sellingPricePaise ||
          before.taxRateBp !== parsed.value.taxRateBp;
        await tx.insert(auditLogs).values({
          hospitalId: args.hospitalId,
          actorUserId: args.actorUserId,
          action: priceChanged ? 'billing.price_changed' : 'ipd.charge_item_updated',
          objectType: 'charge_item',
          objectId: before.id,
          metadata: {
            name: parsed.value.name,
            ...(priceChanged
              ? {
                  fromPaise: before.sellingPricePaise,
                  toPaise: parsed.value.sellingPricePaise,
                  fromTaxRateBp: before.taxRateBp,
                  toTaxRateBp: parsed.value.taxRateBp,
                }
              : { previousName: before.name }),
          },
        });
        const billed =
          before.sellingPricePaise === null && parsed.value.sellingPricePaise !== null
            ? await billUnbilledEntriesForItemsInTx(tx, {
                chargeItemIds: [before.id],
                actorUserId: args.actorUserId,
              })
            : 0;
        return { billed };
      },
      { clinical: true },
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new IpdConfigError(`Another item is already called ${parsed.value.name}`);
    throw err;
  }
}

export async function setChargeItemActive(args: {
  hospitalId: string;
  chargeItemId: string;
  active: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .update(chargeItems)
      .set({ active: args.active, updatedAt: new Date() })
      .where(eq(chargeItems.id, args.chargeItemId))
      .returning({ id: chargeItems.id });
    if (!row) throw new IpdConfigError('Item not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active ? 'ipd.charge_item_activated' : 'ipd.charge_item_deactivated',
      objectType: 'charge_item',
      objectId: row.id,
    });
  });
}

/**
 * Saves a previewed CSV. New names are added; a name already in the list has
 * its price (and unit, tax) replaced when the row carries a price, which is
 * how a hospital re-imports next year's rates. A blank price never wipes an
 * existing one.
 */
export async function importChargeItems(args: {
  hospitalId: string;
  rows: readonly CsvImportRow[];
  actorUserId: string;
}): Promise<{ added: number; repriced: number; unchanged: number; billed: number }> {
  if (args.rows.length === 0) return { added: 0, repriced: 0, unchanged: 0, billed: 0 };
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const existing = await tx
        .select({
          id: chargeItems.id,
          kind: chargeItems.kind,
          lowerName: sql<string>`lower(${chargeItems.name})`,
          sellingPricePaise: chargeItems.sellingPricePaise,
          taxRateBp: chargeItems.taxRateBp,
          unit: chargeItems.unit,
        })
        .from(chargeItems)
        .for('update');
      const byKey = new Map(existing.map((row) => [`${row.kind}:${row.lowerName}`, row]));

      let added = 0;
      let unchanged = 0;
      const repriced: { id: string; from: number | null; to: number | null }[] = [];
      const newlyPriced: string[] = [];

      for (const row of args.rows) {
        const found = byKey.get(`${row.kind}:${row.name.toLowerCase()}`);
        if (!found) {
          await tx.insert(chargeItems).values({
            hospitalId: args.hospitalId,
            kind: row.kind,
            name: row.name,
            unit: row.unit,
            sellingPricePaise: row.sellingPricePaise,
            taxRateBp: row.taxRateBp,
            isTest: row.isTest,
            createdByUserId: args.actorUserId,
          });
          added += 1;
          continue;
        }
        if (
          row.sellingPricePaise === null ||
          (row.sellingPricePaise === found.sellingPricePaise &&
            row.taxRateBp === found.taxRateBp &&
            row.unit === found.unit)
        ) {
          unchanged += 1;
          continue;
        }
        await tx
          .update(chargeItems)
          .set({
            sellingPricePaise: row.sellingPricePaise,
            taxRateBp: row.taxRateBp,
            unit: row.unit,
            active: true,
            updatedAt: new Date(),
          })
          .where(eq(chargeItems.id, found.id));
        repriced.push({ id: found.id, from: found.sellingPricePaise, to: row.sellingPricePaise });
        if (found.sellingPricePaise === null) newlyPriced.push(found.id);
      }

      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'ipd.charge_items_imported',
        objectType: 'charge_item',
        metadata: { added, unchanged, repriced },
      });
      const billed = await billUnbilledEntriesForItemsInTx(tx, {
        chargeItemIds: newlyPriced,
        actorUserId: args.actorUserId,
      });
      return { added, repriced: repriced.length, unchanged, billed };
    },
    { clinical: true },
  );
}

/**
 * The "Set prices" screen's single Save. Every change is audited with both
 * amounts, as one entry per item, and items priced for the first time bill
 * the entries that were waiting for them.
 */
export async function setChargeItemPrices(args: {
  hospitalId: string;
  edits: readonly PriceEdit[];
  actorUserId: string;
}): Promise<{ changed: number; billed: number }> {
  if (args.edits.length === 0) return { changed: 0, billed: 0 };
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const ids = args.edits.map((edit) => edit.id);
      const before = await tx
        .select({ id: chargeItems.id, name: chargeItems.name, price: chargeItems.sellingPricePaise })
        .from(chargeItems)
        .where(inArray(chargeItems.id, ids))
        .for('update');
      const byId = new Map(before.map((row) => [row.id, row]));

      let changed = 0;
      const newlyPriced: string[] = [];
      for (const edit of args.edits) {
        const row = byId.get(edit.id);
        if (!row || row.price === edit.sellingPricePaise) continue;
        await tx
          .update(chargeItems)
          .set({ sellingPricePaise: edit.sellingPricePaise, updatedAt: new Date() })
          .where(eq(chargeItems.id, row.id));
        await tx.insert(auditLogs).values({
          hospitalId: args.hospitalId,
          actorUserId: args.actorUserId,
          action: 'billing.price_changed',
          objectType: 'charge_item',
          objectId: row.id,
          metadata: { name: row.name, fromPaise: row.price, toPaise: edit.sellingPricePaise },
        });
        if (row.price === null) newlyPriced.push(row.id);
        changed += 1;
      }
      const billed = await billUnbilledEntriesForItemsInTx(tx, {
        chargeItemIds: newlyPriced,
        actorUserId: args.actorUserId,
      });
      return { changed, billed };
    },
    { clinical: true },
  );
}

/* ---------------------------------------------------------- starter list */

/**
 * Loads STARTER_CHARGE_ITEMS, unpriced. Anything already present (by kind +
 * name, any case) is left untouched, so this is safe to run again.
 */
export async function addStarterChargeItemsInTx(
  tx: Tx,
  args: { hospitalId: string; actorUserId: string | null },
): Promise<number> {
  const inserted = await tx
    .insert(chargeItems)
    .values(
      STARTER_CHARGE_ITEMS.map((item) => ({
        hospitalId: args.hospitalId,
        kind: item.kind,
        name: item.name,
        unit: item.unit,
        isTest: item.isTest,
        createdByUserId: args.actorUserId,
      })),
    )
    .onConflictDoNothing()
    .returning({ id: chargeItems.id });
  return inserted.length;
}

export async function addStarterChargeItems(args: {
  hospitalId: string;
  actorUserId: string;
}): Promise<{ added: number }> {
  return withTenant(args.hospitalId, async (tx) => {
    const added = await addStarterChargeItemsInTx(tx, args);
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'ipd.starter_items_added',
      objectType: 'charge_item',
      metadata: { added },
    });
    return { added };
  });
}

/**
 * The bedside "not in the list? add it" path. Created unpriced, so the nurse
 * is never blocked and the owner still sets every price. If it already exists
 * (a spelling the search missed), that one is returned.
 */
export async function quickAddChargeItemInTx(
  tx: Tx,
  args: { hospitalId: string; kind: ChargeItemKind; name: string; actorUserId: string },
): Promise<{ id: string; name: string; unit: string }> {
  const parsed = parseChargeItemInput({ kind: args.kind, name: args.name });
  if (!parsed.ok) throw new IpdConfigError(parsed.error);
  await tx
    .insert(chargeItems)
    .values({ hospitalId: args.hospitalId, ...parsed.value, createdByUserId: args.actorUserId })
    .onConflictDoNothing();
  const [row] = await tx
    .select({ id: chargeItems.id, name: chargeItems.name, unit: chargeItems.unit, active: chargeItems.active })
    .from(chargeItems)
    .where(
      and(
        eq(chargeItems.kind, parsed.value.kind),
        sql`lower(${chargeItems.name}) = lower(${parsed.value.name})`,
      ),
    );
  if (!row) throw new IpdConfigError('Could not add the item. Try again.');
  if (!row.active) throw new IpdConfigError(`${row.name} has been removed from the price list by the owner`);
  return { id: row.id, name: row.name, unit: row.unit };
}
