import { and, asc, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import {
  admissions,
  auditLogs,
  bedAssignments,
  beds,
  billItems,
  careEntries,
  chargeItems,
  medicines,
  recordAccessLogs,
  users,
} from '@/lib/db/schema';
import {
  UNDO_WINDOW_MS,
  canUndoEntry,
  occurredAtRefusal,
  type CareEntryInput,
} from '@/lib/domain/care-entry';
import type { ChargeItemKind } from '@/lib/domain/ipd-config';
import { escapeLikePattern, medicineLabel, parseMedicineInput, tidy } from '@/lib/domain/medicine';
import { STARTER_CHARGE_ITEMS } from '@/lib/domain/starter-charge-items';
import { STARTER_MEDICINES } from '@/lib/domain/starter-medicines';
import { BILLABLE_ADMISSION_STATUSES, postCareEntryLineInTx, voidCareEntryLineInTx } from '@/lib/services/ipd-billing';
import { quickAddChargeItemInTx } from '@/lib/services/ipd-config';

/**
 * Bedside entries (IPD plan §5.6, task T1.7): what was given or used, by
 * whom, when — and, in the same transaction, the bill line it costs.
 *
 * Each entry is its own transaction, so one bad entry in an offline batch
 * never blocks the rest. Each carries a client id generated on the phone; a
 * retry finds the first row (care_entries_client_key) and posts nothing new
 * (bill_items_care_entry_once).
 *
 * All of this is clinical: every transaction holds the clinical key.
 * Authorisation is the caller's (`ipd.record`, `ipd.correct`).
 */

export class CareEntryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CareEntryError';
  }
}

type CareEntryRow = typeof careEntries.$inferSelect;

export type RecordOutcome =
  | { clientId: string; ok: true; entryId: string; description: string; billed: boolean; repeat: boolean }
  | { clientId: string; ok: false; error: string };

type ResolvedItem = { medicineId: string | null; chargeItemId: string | null; description: string };

async function resolveItemInTx(
  tx: Tx,
  args: { hospitalId: string; item: CareEntryInput['item']; actorUserId: string },
): Promise<ResolvedItem> {
  const { item } = args;
  if (item.type === 'medicine') {
    const [row] = await tx
      .select({ id: medicines.id, name: medicines.name, strength: medicines.strength, form: medicines.form, active: medicines.active })
      .from(medicines)
      .where(eq(medicines.id, item.id));
    if (!row) throw new CareEntryError('Medicine not found');
    if (!row.active) throw new CareEntryError(`${medicineLabel(row)} has been removed from the list`);
    return { medicineId: row.id, chargeItemId: null, description: medicineLabel(row) };
  }
  if (item.type === 'charge') {
    const [row] = await tx
      .select({ id: chargeItems.id, name: chargeItems.name, active: chargeItems.active })
      .from(chargeItems)
      .where(eq(chargeItems.id, item.id));
    if (!row) throw new CareEntryError('Item not found');
    if (!row.active) throw new CareEntryError(`${row.name} has been removed from the list`);
    return { medicineId: null, chargeItemId: row.id, description: row.name };
  }

  // "Not in the list": created unpriced, so the nurse is never blocked and the
  // owner still sets the price. A spelling that already exists is reused.
  if (item.kind === 'medicine') {
    const parsed = parseMedicineInput({ name: item.name });
    if (!parsed.ok) throw new CareEntryError(parsed.error);
    await tx
      .insert(medicines)
      .values({ hospitalId: args.hospitalId, ...parsed.value, createdByUserId: args.actorUserId })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ id: medicines.id, name: medicines.name, strength: medicines.strength, form: medicines.form, active: medicines.active })
      .from(medicines)
      .where(
        and(
          sql`lower(${medicines.name}) = lower(${parsed.value.name})`,
          sql`coalesce(lower(${medicines.strength}), '') = ''`,
          sql`coalesce(lower(${medicines.form}), '') = ''`,
        ),
      );
    if (!row?.active) throw new CareEntryError(`${parsed.value.name} has been removed from the list`);
    return { medicineId: row.id, chargeItemId: null, description: medicineLabel(row) };
  }
  const added = await quickAddChargeItemInTx(tx, {
    hospitalId: args.hospitalId,
    kind: item.kind as ChargeItemKind,
    name: item.name,
    actorUserId: args.actorUserId,
  });
  return { medicineId: null, chargeItemId: added.id, description: added.name };
}

/** Records one entry and bills it. Returns the outcome; never throws for a bad entry. */
async function recordOne(args: {
  hospitalId: string;
  entry: CareEntryInput;
  actorUserId: string;
  now: Date;
}): Promise<RecordOutcome> {
  const occurredAt = new Date(args.entry.occurredAt);
  const refusal = occurredAtRefusal(occurredAt, args.now);
  if (refusal) {
    return {
      clientId: args.entry.clientId,
      ok: false,
      error: refusal === 'future' ? 'The time given is in the future' : 'That was too long ago to record here. Tell the desk.',
    };
  }
  try {
    return await withTenant(
      args.hospitalId,
      async (tx) => {
        // A retry of an entry already saved: return it as it is.
        const [existing] = await tx
          .select()
          .from(careEntries)
          .where(eq(careEntries.clientId, args.entry.clientId));
        if (existing) {
          if (existing.admissionId !== args.entry.admissionId) throw new CareEntryError('Entry belongs to another patient');
          return {
            clientId: args.entry.clientId,
            ok: true as const,
            entryId: existing.id,
            description: existing.description,
            billed: await hasLiveLine(tx, existing.id),
            repeat: true,
          };
        }

        // FOR SHARE: a discharge finalising this stay waits, and is waited for.
        const [admission] = await tx
          .select({
            id: admissions.id,
            status: admissions.status,
            encounterId: admissions.encounterId,
            patientId: admissions.patientId,
          })
          .from(admissions)
          .where(eq(admissions.id, args.entry.admissionId))
          .for('share');
        if (!admission) throw new CareEntryError('Patient not found');
        if (!(BILLABLE_ADMISSION_STATUSES as readonly string[]).includes(admission.status)) {
          throw new CareEntryError(
            admission.status === 'discharged'
              ? 'This patient has been discharged'
              : 'This patient does not have a bed yet',
          );
        }

        const item = await resolveItemInTx(tx, {
          hospitalId: args.hospitalId,
          item: args.entry.item,
          actorUserId: args.actorUserId,
        });
        const [entry] = await tx
          .insert(careEntries)
          .values({
            hospitalId: args.hospitalId,
            admissionId: admission.id,
            encounterId: admission.encounterId,
            patientId: admission.patientId,
            medicineId: item.medicineId,
            chargeItemId: item.chargeItemId,
            description: item.description,
            quantity: args.entry.quantity,
            occurredAt,
            recordedAt: args.now,
            recordedByUserId: args.actorUserId,
            clientId: args.entry.clientId,
          })
          .returning();
        const billed = await postCareEntryLineInTx(tx, { entry, actorUserId: args.actorUserId });
        return {
          clientId: args.entry.clientId,
          ok: true as const,
          entryId: entry.id,
          description: entry.description,
          billed,
          repeat: false,
        };
      },
      { clinical: true },
    );
  } catch (err) {
    // A concurrent retry won the race on the client id: the entry is saved.
    if (isClientKeyRace(err)) {
      const [saved] = await withTenant(
        args.hospitalId,
        (tx) => tx.select().from(careEntries).where(eq(careEntries.clientId, args.entry.clientId)),
        { clinical: true },
      );
      if (saved) {
        return { clientId: args.entry.clientId, ok: true, entryId: saved.id, description: saved.description, billed: true, repeat: true };
      }
    }
    if (err instanceof CareEntryError) return { clientId: args.entry.clientId, ok: false, error: err.message };
    throw err;
  }
}

const isClientKeyRace = (err: unknown): boolean => {
  for (let e = err as { code?: string; constraint_name?: string; cause?: unknown } | undefined; e; e = e.cause as typeof e) {
    if (e.code === '23505' && e.constraint_name === 'care_entries_client_key') return true;
  }
  return false;
};

async function hasLiveLine(tx: Tx, careEntryId: string): Promise<boolean> {
  const [line] = await tx
    .select({ id: billItems.id })
    .from(billItems)
    .where(and(eq(billItems.careEntryId, careEntryId), isNull(billItems.voidedAt)));
  return Boolean(line);
}

/** Records a batch (one save, or an offline outbox flush), entry by entry. */
export async function recordCareEntries(args: {
  hospitalId: string;
  entries: readonly CareEntryInput[];
  actorUserId: string;
  now?: Date;
}): Promise<RecordOutcome[]> {
  const now = args.now ?? new Date();
  const outcomes: RecordOutcome[] = [];
  for (const entry of args.entries) {
    outcomes.push(await recordOne({ hospitalId: args.hospitalId, entry, actorUserId: args.actorUserId, now }));
  }
  return outcomes;
}

async function lockEntryInTx(tx: Tx, entryId: string): Promise<CareEntryRow> {
  const [entry] = await tx.select().from(careEntries).where(eq(careEntries.id, entryId)).for('update');
  if (!entry) throw new CareEntryError('Entry not found');
  if (entry.voidedAt) throw new CareEntryError('This entry was already removed');
  return entry;
}

async function assertStayOpenInTx(tx: Tx, admissionId: string) {
  const [admission] = await tx
    .select({ status: admissions.status })
    .from(admissions)
    .where(eq(admissions.id, admissionId));
  if (admission?.status === 'discharged') {
    throw new CareEntryError('This stay is discharged and its bill is final. Correct it on the bill.');
  }
}

/** The nurse's Undo: her own entry, within two minutes. Voids the line too. */
export async function undoCareEntry(args: {
  hospitalId: string;
  entryId: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  const now = args.now ?? new Date();
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const entry = await lockEntryInTx(tx, args.entryId);
      if (
        !canUndoEntry({
          recordedByUserId: entry.recordedByUserId,
          actorUserId: args.actorUserId,
          recordedAt: entry.recordedAt,
          voided: false,
          now,
        })
      ) {
        throw new CareEntryError(
          `Undo is only possible for ${UNDO_WINDOW_MS / 60_000} minutes, on your own entries. Ask the desk to correct it.`,
        );
      }
      await assertStayOpenInTx(tx, entry.admissionId);
      await voidInTx(tx, entry, args.actorUserId, 'Undone by the person who recorded it', now);
    },
    { clinical: true },
  );
}

/** The desk's correction after the undo window: any entry, with a reason (D-UN). */
export async function voidCareEntry(args: {
  hospitalId: string;
  entryId: string;
  reason: string;
  actorUserId: string;
}): Promise<void> {
  const reason = tidy(args.reason);
  if (!reason) throw new CareEntryError('Say why this entry is wrong');
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const entry = await lockEntryInTx(tx, args.entryId);
      await assertStayOpenInTx(tx, entry.admissionId);
      await voidInTx(tx, entry, args.actorUserId, reason.slice(0, 200), new Date());
    },
    { clinical: true },
  );
}

async function voidInTx(tx: Tx, entry: CareEntryRow, actorUserId: string, reason: string, now: Date) {
  await tx
    .update(careEntries)
    .set({ voidedAt: now, voidedByUserId: actorUserId, voidReason: reason })
    .where(eq(careEntries.id, entry.id));
  await voidCareEntryLineInTx(tx, { careEntryId: entry.id, actorUserId, reason });
  await tx.insert(auditLogs).values({
    hospitalId: entry.hospitalId,
    actorUserId,
    action: 'ipd.care_entry_voided',
    objectType: 'care_entry',
    objectId: entry.id,
    metadata: { admissionId: entry.admissionId, reason },
  });
}

/* ------------------------------------------------------------------ reads */

export type TimelineEntry = {
  id: string;
  description: string;
  quantity: number;
  occurredAt: Date;
  recordedAt: Date;
  recordedByUserId: string | null;
  recordedByName: string | null;
  voidedAt: Date | null;
  voidReason: string | null;
  /** The bill line's total; null when unpriced (or for roles not shown money). */
  amountPaise: number | null;
  unpriced: boolean;
};

/**
 * Every entry of a stay, newest first, with what it was billed at. Logs the
 * read in record_access_logs: opening a patient's IPD page reads their record.
 */
export async function listEntriesForAdmission(args: {
  hospitalId: string;
  admissionId: string;
  actorUserId: string;
  logView?: boolean;
}): Promise<TimelineEntry[]> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const rows = await tx
        .select({
          id: careEntries.id,
          description: careEntries.description,
          quantity: careEntries.quantity,
          occurredAt: careEntries.occurredAt,
          recordedAt: careEntries.recordedAt,
          recordedByUserId: careEntries.recordedByUserId,
          recordedByName: users.name,
          voidedAt: careEntries.voidedAt,
          voidReason: careEntries.voidReason,
          patientId: careEntries.patientId,
          encounterId: careEntries.encounterId,
          amountPaise: billItems.totalPaise,
          medicinePrice: medicines.sellingPricePaise,
          chargePrice: chargeItems.sellingPricePaise,
          medicineId: careEntries.medicineId,
        })
        .from(careEntries)
        .leftJoin(users, eq(users.id, careEntries.recordedByUserId))
        .leftJoin(billItems, and(eq(billItems.careEntryId, careEntries.id), isNull(billItems.voidedAt)))
        .leftJoin(medicines, eq(medicines.id, careEntries.medicineId))
        .leftJoin(chargeItems, eq(chargeItems.id, careEntries.chargeItemId))
        .where(eq(careEntries.admissionId, args.admissionId))
        .orderBy(desc(careEntries.occurredAt));

      if (args.logView) {
        const [admission] = await tx
          .select({ patientId: admissions.patientId, encounterId: admissions.encounterId })
          .from(admissions)
          .where(eq(admissions.id, args.admissionId));
        if (admission) {
          await tx.insert(recordAccessLogs).values({
            hospitalId: args.hospitalId,
            actorUserId: args.actorUserId,
            patientId: admission.patientId,
            encounterId: admission.encounterId,
            action: 'view_admission',
          });
        }
      }

      return rows.map((row) => ({
        id: row.id,
        description: row.description,
        quantity: row.quantity,
        occurredAt: row.occurredAt,
        recordedAt: row.recordedAt,
        recordedByUserId: row.recordedByUserId,
        recordedByName: row.recordedByName,
        voidedAt: row.voidedAt,
        voidReason: row.voidReason,
        amountPaise: row.amountPaise,
        unpriced: (row.medicineId ? row.medicinePrice : row.chargePrice) === null,
      }));
    },
    { clinical: true },
  );
}

export type PickItem = {
  ref: { type: 'medicine' | 'charge'; id: string };
  label: string;
  unit: string;
};

const pickKey = (item: PickItem) => `${item.ref.type}:${item.ref.id}`;

/**
 * The record screen's one-tap lists: this patient's items from the last 48
 * hours, then the ward's 12 most used over 30 days — topped up from the
 * starter lists while a ward is new, so it is never empty on day one.
 * Names and units only; nurses never see prices.
 */
export async function getQuickPicks(args: {
  hospitalId: string;
  admissionId: string;
  now?: Date;
}): Promise<{ recent: PickItem[]; common: PickItem[] }> {
  const now = args.now ?? new Date();
  return withTenant(
    args.hospitalId,
    async (tx) => {
      const itemColumns = {
        medicineId: careEntries.medicineId,
        chargeItemId: careEntries.chargeItemId,
        medicineName: medicines.name,
        medicineStrength: medicines.strength,
        medicineForm: medicines.form,
        medicineUnit: medicines.unit,
        chargeName: chargeItems.name,
        chargeUnit: chargeItems.unit,
      };
      const toPick = (row: {
        medicineId: string | null;
        chargeItemId: string | null;
        medicineName: string | null;
        medicineStrength: string | null;
        medicineForm: string | null;
        medicineUnit: string | null;
        chargeName: string | null;
        chargeUnit: string | null;
      }): PickItem | null =>
        row.medicineId && row.medicineName
          ? {
              ref: { type: 'medicine', id: row.medicineId },
              label: medicineLabel({ name: row.medicineName, strength: row.medicineStrength, form: row.medicineForm }),
              unit: row.medicineUnit ?? 'unit',
            }
          : row.chargeItemId && row.chargeName
            ? { ref: { type: 'charge', id: row.chargeItemId }, label: row.chargeName, unit: row.chargeUnit ?? 'unit' }
            : null;

      const activeItem = sql`(${medicines.active} is true or ${chargeItems.active} is true)`;
      const recentRows = await tx
        .select({ ...itemColumns, last: sql<Date>`max(${careEntries.occurredAt})` })
        .from(careEntries)
        .leftJoin(medicines, eq(medicines.id, careEntries.medicineId))
        .leftJoin(chargeItems, eq(chargeItems.id, careEntries.chargeItemId))
        .where(
          and(
            eq(careEntries.admissionId, args.admissionId),
            isNull(careEntries.voidedAt),
            gte(careEntries.occurredAt, new Date(now.getTime() - 48 * 3_600_000)),
            activeItem,
          ),
        )
        .groupBy(
          careEntries.medicineId,
          careEntries.chargeItemId,
          medicines.name,
          medicines.strength,
          medicines.form,
          medicines.unit,
          chargeItems.name,
          chargeItems.unit,
        )
        .orderBy(desc(sql`max(${careEntries.occurredAt})`))
        .limit(8);
      const recent = recentRows.map(toPick).filter((item): item is PickItem => item !== null);

      // The ward this patient is in now.
      const [current] = await tx
        .select({ wardId: beds.wardId })
        .from(bedAssignments)
        .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
        .where(and(eq(bedAssignments.admissionId, args.admissionId), isNull(bedAssignments.toAt)));

      let common: PickItem[] = [];
      if (current) {
        const wardRows = await tx
          .select({ ...itemColumns, uses: sql<number>`count(*)::int` })
          .from(careEntries)
          .innerJoin(bedAssignments, eq(bedAssignments.admissionId, careEntries.admissionId))
          .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
          .leftJoin(medicines, eq(medicines.id, careEntries.medicineId))
          .leftJoin(chargeItems, eq(chargeItems.id, careEntries.chargeItemId))
          .where(
            and(
              eq(beds.wardId, current.wardId),
              isNull(careEntries.voidedAt),
              gte(careEntries.occurredAt, new Date(now.getTime() - 30 * 86_400_000)),
              sql`${careEntries.occurredAt} >= ${bedAssignments.fromAt}`,
              sql`(${bedAssignments.toAt} is null or ${careEntries.occurredAt} < ${bedAssignments.toAt})`,
              activeItem,
            ),
          )
          .groupBy(
            careEntries.medicineId,
            careEntries.chargeItemId,
            medicines.name,
            medicines.strength,
            medicines.form,
            medicines.unit,
            chargeItems.name,
            chargeItems.unit,
          )
          .orderBy(desc(sql`count(*)`))
          .limit(12);
        common = wardRows.map(toPick).filter((item): item is PickItem => item !== null);
      }

      // What is already under "Given recently" is not repeated; the list is
      // then topped up to twelve so it is never short.
      const recentKeys = new Set(recent.map(pickKey));
      common = common.filter((item) => !recentKeys.has(pickKey(item)));
      if (common.length < 12) {
        common = [...common, ...(await starterFallbackInTx(tx, 12 - common.length, [...common, ...recent]))];
      }
      return { recent, common };
    },
    { clinical: true },
  );
}

/**
 * Starter items in starter order, for a ward without history: the bedside
 * consumables and procedures first, then the ward medicines (injections and
 * fluids), as they appear in the starter lists.
 */
async function starterFallbackInTx(tx: Tx, count: number, already: readonly PickItem[]): Promise<PickItem[]> {
  const have = new Set(already.map(pickKey));
  const chargeOrder = STARTER_CHARGE_ITEMS.filter((item) => item.kind === 'consumable' || item.kind === 'procedure');
  const medicineOrder = STARTER_MEDICINES.filter((item) => item.form === 'injection' || item.form === 'IV fluid');

  const [chargeRows, medicineRows] = await Promise.all([
    tx
      .select({ id: chargeItems.id, name: chargeItems.name, unit: chargeItems.unit, kind: chargeItems.kind })
      .from(chargeItems)
      .where(and(eq(chargeItems.active, true), inArray(chargeItems.kind, ['consumable', 'procedure']))),
    tx
      .select({ id: medicines.id, name: medicines.name, strength: medicines.strength, form: medicines.form, unit: medicines.unit })
      .from(medicines)
      .where(and(eq(medicines.active, true), inArray(medicines.form, ['injection', 'IV fluid']))),
  ]);

  const picks: PickItem[] = [];
  const chargeByName = new Map(chargeRows.map((row) => [`${row.kind}:${row.name.toLowerCase()}`, row]));
  const medicineByLabel = new Map(medicineRows.map((row) => [medicineLabel(row).toLowerCase(), row]));
  const interleaved: (() => PickItem | null)[] = [];
  const max = Math.max(chargeOrder.length, medicineOrder.length);
  for (let i = 0; i < max; i += 1) {
    const charge = chargeOrder[i];
    if (charge) {
      interleaved.push(() => {
        const row = chargeByName.get(`${charge.kind}:${charge.name.toLowerCase()}`);
        return row ? { ref: { type: 'charge', id: row.id }, label: row.name, unit: row.unit } : null;
      });
    }
    const medicine = medicineOrder[i];
    if (medicine) {
      interleaved.push(() => {
        const row = medicineByLabel.get(medicineLabel(medicine).toLowerCase());
        return row ? { ref: { type: 'medicine', id: row.id }, label: medicineLabel(row), unit: row.unit } : null;
      });
    }
  }
  for (const next of interleaved) {
    if (picks.length >= count) break;
    const pick = next();
    if (pick && !have.has(pickKey(pick))) {
      picks.push(pick);
      have.add(pickKey(pick));
    }
  }
  return picks;
}

/**
 * The record screen's search: medicines and charge items whose name starts
 * with the term, active only, at most 10. Names only — no price is in the
 * response at all (as ADR-014 for the doctor's search).
 */
export async function searchCareItems(args: { hospitalId: string; query: string }): Promise<PickItem[]> {
  const term = tidy(args.query).toLowerCase();
  if (term.length === 0) return [];
  const prefix = `${escapeLikePattern(term)}%`;
  const word = `% ${escapeLikePattern(term)}%`;
  return withTenant(args.hospitalId, async (tx) => {
    const [meds, charges] = await Promise.all([
      tx
        .select({ id: medicines.id, name: medicines.name, strength: medicines.strength, form: medicines.form, unit: medicines.unit })
        .from(medicines)
        .where(
          and(
            eq(medicines.active, true),
            sql`(lower(${medicines.name}) like ${prefix} or lower(${medicines.genericName}) like ${prefix} or lower(${medicines.name}) like ${word})`,
          ),
        )
        .orderBy(asc(sql`lower(${medicines.name})`))
        .limit(10),
      tx
        .select({ id: chargeItems.id, name: chargeItems.name, unit: chargeItems.unit })
        .from(chargeItems)
        .where(
          and(
            eq(chargeItems.active, true),
            sql`(lower(${chargeItems.name}) like ${prefix} or lower(${chargeItems.name}) like ${word})`,
          ),
        )
        .orderBy(asc(sql`lower(${chargeItems.name})`))
        .limit(10),
    ]);
    const results: PickItem[] = [
      ...meds.map((row) => ({ ref: { type: 'medicine' as const, id: row.id }, label: medicineLabel(row), unit: row.unit })),
      ...charges.map((row) => ({ ref: { type: 'charge' as const, id: row.id }, label: row.name, unit: row.unit })),
    ];
    // Exact prefix matches first, then alphabetical.
    results.sort((a, b) => {
      const ap = a.label.toLowerCase().startsWith(term) ? 0 : 1;
      const bp = b.label.toLowerCase().startsWith(term) ? 0 : 1;
      return ap - bp || a.label.localeCompare(b.label);
    });
    return results.slice(0, 10);
  });
}
