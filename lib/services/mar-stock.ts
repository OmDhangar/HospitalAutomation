import { and, asc, eq, gt, gte, like, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { hospitals, medicineRiskClasses, stockBalances, stockBatches, stockLedger, stockLocations } from '@/lib/db/schema';
import { doseReference, planDraw, reversalReference, wasteReference } from '@/lib/domain/stock';
import { serviceDateIn } from '@/lib/domain/time';

/**
 * The treatment card's side of the stock ledger (IPD sheets plan B4b, §7.3;
 * migration 0050). Transaction helpers only: each runs inside the dose's or
 * waste's own clinical transaction, so a dose and its stock movement are
 * saved together or not at all.
 *
 * A dose is taken off one store, earliest expiry first (never an expired
 * batch), all or nothing. If the store does not hold enough — or someone took
 * the last ampoule a moment earlier — the dose is still saved and marked
 * short; it never waits on the books. Every ledger row carries a reference
 * ("mar:<dose>:<n>", "waste:<waste>:<n>"), unique in the database, so a retry
 * cannot take stock twice, and the rows can be put back exactly.
 */

export type WardStore = { id: string; name: string; kind: string };

/** The active stores of a ward a nurse gives from: the ward store first, then any other (crash cart, …), by name. */
export async function wardStoresInTx(tx: Tx, wardId: string | null): Promise<WardStore[]> {
  if (!wardId) return [];
  return tx
    .select({ id: stockLocations.id, name: stockLocations.name, kind: stockLocations.kind })
    .from(stockLocations)
    .where(and(eq(stockLocations.wardId, wardId), eq(stockLocations.active, true)))
    .orderBy(sql`${stockLocations.kind} <> 'ward_store'`, asc(stockLocations.name));
}

/** Is this medicine tracked in stock (in a risk class)? */
export async function isStockedInTx(tx: Tx, medicineId: string | null): Promise<boolean> {
  if (!medicineId) return false;
  const [row] = await tx.select({ id: medicineRiskClasses.medicineId }).from(medicineRiskClasses).where(eq(medicineRiskClasses.medicineId, medicineId));
  return Boolean(row);
}

async function todayInTx(tx: Tx, hospitalId: string, now: Date): Promise<string> {
  const [row] = await tx.select({ timezone: hospitals.timezone }).from(hospitals).where(eq(hospitals.id, hospitalId));
  return serviceDateIn(row?.timezone ?? 'Asia/Kolkata', now);
}

/** Usable batches of a medicine in a store: in stock, not expired. */
async function usableBatchesInTx(tx: Tx, args: { hospitalId: string; locationId: string; medicineId: string; now: Date }) {
  const today = await todayInTx(tx, args.hospitalId, args.now);
  return tx
    .select({ batchId: stockBatches.id, batchNo: stockBatches.batchNo, expiryDate: stockBatches.expiryDate, quantity: stockBalances.quantity })
    .from(stockBalances)
    .innerJoin(stockBatches, eq(stockBatches.id, stockBalances.batchId))
    .where(
      and(
        eq(stockBalances.locationId, args.locationId),
        eq(stockBalances.medicineId, args.medicineId),
        gt(stockBalances.quantity, 0),
        gte(stockBatches.expiryDate, today),
      ),
    );
}

/** The CHECK on stock_balances refused a row: someone else used the stock first. */
const isShortfall = (err: unknown): boolean => {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23514' && e.constraint_name === 'stock_balances_quantity_check') return true;
  }
  return false;
};

/**
 * Takes `units` of a medicine off a store for a dose or a waste, earliest
 * expiry first. Returns 'short' (and posts nothing) when the store cannot
 * cover it. Runs in a savepoint so a race lost to another give rolls back
 * only the stock rows, never the dose.
 */
export async function drawInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    subject: { kind: 'dose' | 'waste'; id: string };
    locationId: string;
    medicineId: string;
    units: number;
    occurredAt: Date;
    actorUserId: string | null;
    now: Date;
  },
): Promise<'posted' | 'short'> {
  const batches = await usableBatchesInTx(tx, args);
  const plan = planDraw(batches, args.units);
  if (!plan) return 'short';
  const kind = args.subject.kind === 'dose' ? 'give' : 'waste';
  const reference = args.subject.kind === 'dose' ? doseReference : wasteReference;
  // A retry after a short (posting by hand) continues the numbering, so references never collide.
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(stockLedger)
    .where(like(stockLedger.referenceKey, `${args.subject.kind === 'dose' ? 'mar' : 'waste'}:${args.subject.id}:%`));
  try {
    await tx.transaction(async (sp) => {
      let i = n;
      for (const row of plan) {
        i += 1;
        await sp.insert(stockLedger).values({
          hospitalId: args.hospitalId,
          locationId: args.locationId,
          medicineId: args.medicineId,
          batchId: row.batchId,
          kind,
          quantity: -row.quantity,
          source: 'mar',
          occurredAt: args.occurredAt,
          recordedAt: args.now,
          recordedByUserId: args.actorUserId,
          referenceKey: reference(args.subject.id, i),
        });
      }
    });
  } catch (err) {
    if (isShortfall(err)) return 'short';
    throw err;
  }
  return 'posted';
}

/**
 * Puts back everything a dose or waste took off stock (it was struck out):
 * one reversal per ledger row, referenced to it, so it can only happen once.
 * Returns how many rows were put back.
 */
export async function putBackInTx(
  tx: Tx,
  args: { hospitalId: string; subject: { kind: 'dose' | 'waste'; id: string }; actorUserId: string; now: Date },
): Promise<number> {
  const prefix = `${args.subject.kind === 'dose' ? 'mar' : 'waste'}:${args.subject.id}:%`;
  const rows = await tx
    .select({ id: stockLedger.id, locationId: stockLedger.locationId, medicineId: stockLedger.medicineId, batchId: stockLedger.batchId, quantity: stockLedger.quantity })
    .from(stockLedger)
    .where(like(stockLedger.referenceKey, prefix));
  for (const row of rows) {
    await tx
      .insert(stockLedger)
      .values({
        hospitalId: args.hospitalId,
        locationId: row.locationId,
        medicineId: row.medicineId,
        batchId: row.batchId,
        kind: 'reversal',
        quantity: -row.quantity,
        source: 'mar',
        occurredAt: args.now,
        recordedAt: args.now,
        recordedByUserId: args.actorUserId,
        referenceKey: reversalReference(row.id),
      })
      .onConflictDoNothing();
  }
  return rows.length;
}
