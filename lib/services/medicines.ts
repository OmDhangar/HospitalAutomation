import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { auditLogs, medicines } from '@/lib/db/schema';
import {
  escapeLikePattern,
  medicineLabel,
  parseMedicineInput,
  tidy,
} from '@/lib/domain/medicine';
import { STARTER_MEDICINES } from '@/lib/domain/starter-medicines';

/**
 * The hospital's medicine catalogue: what it offers and at what price.
 *
 * This is configuration, not patient data, so it is not behind the clinical
 * key. Authorisation is the caller's (`medicines.manage` for the owner,
 * `medicines.quickAdd` for the doctor); this module keeps the catalogue
 * consistent and records every price change.
 */

export class MedicineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MedicineError';
  }
}

export type MedicineOption = {
  id: string;
  label: string;
  name: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
};

/** A search result for the billing desk: the same, plus what it costs. */
export type PricedMedicineOption = MedicineOption & {
  unit: string;
  sellingPricePaise: number | null;
};

const UNIQUE_VIOLATION = '23505';
const isUniqueViolation = (err: unknown): boolean => {
  for (let e = err as { code?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === UNIQUE_VIOLATION) return true;
  }
  return false;
};

const toOption = (row: {
  id: string;
  name: string;
  genericName: string | null;
  strength: string | null;
  form: string | null;
}): MedicineOption => ({
  id: row.id,
  label: medicineLabel(row),
  name: row.name,
  genericName: row.genericName,
  strength: row.strength,
  form: row.form,
});

/**
 * Typeahead search: a prefix of the name or the generic name, active
 * medicines only, a handful of results.
 *
 * Two shapes, chosen by the caller. The doctor's search returns no price at
 * all — not hidden in the UI, absent from the response — because pricing is
 * not part of a clinical decision. The billing desk's search includes it.
 */
export async function searchMedicines(args: {
  hospitalId: string;
  query: string;
  limit?: number;
}): Promise<MedicineOption[]>;
export async function searchMedicines(args: {
  hospitalId: string;
  query: string;
  limit?: number;
  withPrice: true;
}): Promise<PricedMedicineOption[]>;
export async function searchMedicines(args: {
  hospitalId: string;
  query: string;
  limit?: number;
  withPrice?: boolean;
}): Promise<MedicineOption[] | PricedMedicineOption[]> {
  const term = tidy(args.query).toLowerCase();
  if (term.length === 0) return [];
  const pattern = `${escapeLikePattern(term)}%`;
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 25);

  const rows = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: medicines.id,
        name: medicines.name,
        genericName: medicines.genericName,
        strength: medicines.strength,
        form: medicines.form,
        unit: medicines.unit,
        sellingPricePaise: medicines.sellingPricePaise,
      })
      .from(medicines)
      .where(
        and(
          eq(medicines.active, true),
          sql`(lower(${medicines.name}) like ${pattern} or lower(${medicines.genericName}) like ${pattern})`,
        ),
      )
      .orderBy(asc(sql`lower(${medicines.name})`), asc(medicines.strength))
      .limit(limit),
  );

  if (!args.withPrice) return rows.map(toOption);
  return rows.map((row) => ({
    ...toOption(row),
    unit: row.unit,
    sellingPricePaise: row.sellingPricePaise,
  }));
}

export type CatalogueFilter = 'all' | 'unpriced' | 'inactive';

export type CatalogueRow = PricedMedicineOption & { taxRateBp: number; active: boolean };

/** The owner's catalogue screen. */
export async function listCatalogue(args: {
  hospitalId: string;
  query?: string;
  filter?: CatalogueFilter;
}): Promise<{ rows: CatalogueRow[]; counts: { total: number; unpriced: number; inactive: number } }> {
  const filter = args.filter ?? 'all';
  const term = tidy(args.query ?? '').toLowerCase();

  return withTenant(args.hospitalId, async (tx) => {
    const conditions: SQL[] = [];
    if (term) {
      const pattern = `%${escapeLikePattern(term)}%`;
      conditions.push(
        sql`(lower(${medicines.name}) like ${pattern} or lower(${medicines.genericName}) like ${pattern})`,
      );
    }
    if (filter === 'unpriced') {
      conditions.push(isNull(medicines.sellingPricePaise), eq(medicines.active, true));
    } else if (filter === 'inactive') {
      conditions.push(eq(medicines.active, false));
    } else {
      conditions.push(eq(medicines.active, true));
    }

    const [rows, [counts]] = await Promise.all([
      tx
        .select({
          id: medicines.id,
          name: medicines.name,
          genericName: medicines.genericName,
          strength: medicines.strength,
          form: medicines.form,
          unit: medicines.unit,
          sellingPricePaise: medicines.sellingPricePaise,
          taxRateBp: medicines.taxRateBp,
          active: medicines.active,
        })
        .from(medicines)
        .where(and(...conditions))
        .orderBy(asc(sql`lower(${medicines.name})`), asc(medicines.strength))
        .limit(500),
      tx
        .select({
          total: sql<number>`count(*) filter (where ${medicines.active})::int`,
          unpriced: sql<number>`count(*) filter (where ${medicines.active} and ${medicines.sellingPricePaise} is null)::int`,
          inactive: sql<number>`count(*) filter (where not ${medicines.active})::int`,
        })
        .from(medicines),
    ]);

    return {
      rows: rows.map((row) => ({
        ...toOption(row),
        unit: row.unit,
        sellingPricePaise: row.sellingPricePaise,
        taxRateBp: row.taxRateBp,
        active: row.active,
      })),
      counts,
    };
  });
}

export async function createMedicine(args: {
  hospitalId: string;
  input: unknown;
  actorUserId: string;
}): Promise<MedicineOption> {
  const parsed = parseMedicineInput(args.input);
  if (!parsed.ok) throw new MedicineError(parsed.error);

  try {
    return await withTenant(args.hospitalId, async (tx) => {
      const [row] = await tx
        .insert(medicines)
        .values({ hospitalId: args.hospitalId, ...parsed.value, createdByUserId: args.actorUserId })
        .returning();
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'medicine.created',
        objectType: 'medicine',
        objectId: row.id,
        metadata: { label: medicineLabel(row), sellingPricePaise: row.sellingPricePaise },
      });
      return toOption(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new MedicineError('This medicine is already in the catalogue');
    throw err;
  }
}

/**
 * Edits a medicine. A rename or a new price never reaches an existing record:
 * prescriptions carry their own copy of the name, and bill lines their own
 * copy of the price. Price changes are written to the audit log with both
 * amounts, which is the catalogue's price history.
 */
export async function updateMedicine(args: {
  hospitalId: string;
  medicineId: string;
  input: unknown;
  actorUserId: string;
}): Promise<void> {
  const parsed = parseMedicineInput(args.input);
  if (!parsed.ok) throw new MedicineError(parsed.error);

  try {
    await withTenant(args.hospitalId, async (tx) => {
      const [before] = await tx
        .select()
        .from(medicines)
        .where(eq(medicines.id, args.medicineId))
        .for('update');
      if (!before) throw new MedicineError('Medicine not found');

      await tx
        .update(medicines)
        .set({ ...parsed.value, updatedAt: new Date() })
        .where(eq(medicines.id, before.id));

      const priceChanged =
        before.sellingPricePaise !== parsed.value.sellingPricePaise ||
        before.taxRateBp !== parsed.value.taxRateBp;
      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: priceChanged ? 'billing.price_changed' : 'medicine.updated',
        objectType: 'medicine',
        objectId: before.id,
        metadata: {
          label: medicineLabel(parsed.value),
          ...(priceChanged
            ? {
                fromPaise: before.sellingPricePaise,
                toPaise: parsed.value.sellingPricePaise,
                fromTaxRateBp: before.taxRateBp,
                toTaxRateBp: parsed.value.taxRateBp,
              }
            : { previousLabel: medicineLabel(before) }),
        },
      });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new MedicineError('Another medicine already has this name, strength and form');
    throw err;
  }
}

/**
 * Deactivation is the only way a medicine leaves the catalogue. Old
 * prescriptions and bills still reference it; it simply stops being offered.
 */
export async function setMedicineActive(args: {
  hospitalId: string;
  medicineId: string;
  active: boolean;
  actorUserId: string;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .update(medicines)
      .set({ active: args.active, updatedAt: new Date() })
      .where(eq(medicines.id, args.medicineId))
      .returning({ id: medicines.id });
    if (!row) throw new MedicineError('Medicine not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active ? 'medicine.activated' : 'medicine.deactivated',
      objectType: 'medicine',
      objectId: row.id,
    });
  });
}

/**
 * The doctor's "not in the list? add it" path. Creates the medicine unpriced,
 * so the doctor is never blocked and the owner still controls every price.
 * If it already exists (a spelling the search missed), that one is returned.
 */
export async function quickAddMedicine(args: {
  hospitalId: string;
  name: string;
  strength?: string | null;
  form?: string | null;
  actorUserId: string;
}): Promise<MedicineOption> {
  const parsed = parseMedicineInput({
    name: args.name,
    strength: args.strength ?? null,
    form: args.form ?? null,
  });
  if (!parsed.ok) throw new MedicineError(parsed.error);
  const value = parsed.value;

  return withTenant(args.hospitalId, async (tx) => {
    await tx
      .insert(medicines)
      .values({ hospitalId: args.hospitalId, ...value, createdByUserId: args.actorUserId })
      .onConflictDoNothing();

    const [row] = await findByIdentityInTx(tx, value);
    if (!row) throw new MedicineError('Could not add the medicine. Try again.');
    if (!row.active) {
      throw new MedicineError(`${medicineLabel(row)} has been removed from the catalogue by the owner`);
    }
    return toOption(row);
  });
}

const findByIdentityInTx = (
  tx: Tx,
  value: { name: string; strength: string | null; form: string | null },
) =>
  tx
    .select()
    .from(medicines)
    .where(
      and(
        sql`lower(${medicines.name}) = lower(${value.name})`,
        sql`coalesce(lower(${medicines.strength}), '') = coalesce(lower(${value.strength}), '')`,
        sql`coalesce(lower(${medicines.form}), '') = coalesce(lower(${value.form}), '')`,
      ),
    );

/** Adds the starter list; anything already present is left untouched. */
export async function addStarterMedicines(args: {
  hospitalId: string;
  actorUserId: string;
}): Promise<{ added: number }> {
  return withTenant(args.hospitalId, async (tx) => {
    const inserted = await tx
      .insert(medicines)
      .values(
        STARTER_MEDICINES.map((item) => ({
          hospitalId: args.hospitalId,
          name: item.name,
          strength: item.strength,
          form: item.form,
          unit: item.unit,
          createdByUserId: args.actorUserId,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: medicines.id });

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'medicine.starter_list_added',
      objectType: 'medicine',
      metadata: { added: inserted.length },
    });
    return { added: inserted.length };
  });
}
