import { and, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import {
  admissions,
  bedAssignments,
  beds,
  billItems,
  bills,
  chargeItems,
  encounters,
  hospitals,
  wards,
} from '@/lib/db/schema';
import { chargeableBedDays } from '@/lib/domain/bed-days';
import { calculateBillItem } from '@/lib/domain/patient-billing';
import { getOrCreateDraftBillInTx } from '@/lib/services/patient-billing';

/**
 * Room charges, one line per bed-day (IPD plan §T1.10, decision D-BD).
 *
 * Posted by the sweep that runs on every worker tick, and once more by the
 * discharge bill before it is finalised. Both compute the full list of days
 * from the bed history and insert what is missing; the "one line per bed per
 * day" index (0032) and a check for any room line on that date make a re-run
 * add nothing. A ward without a room charge, or with an unpriced one, is
 * skipped until it has one — and then every day it missed is charged.
 */

const formatDay = (date: string) =>
  new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`));

/** Posts the missing bed-days of one stay. Returns how many lines were added. */
export async function postBedDaysForAdmissionInTx(
  tx: Tx,
  args: { admissionId: string; timezone: string; now: Date; endedAt?: Date | null; actorUserId?: string | null },
): Promise<number> {
  const [admission] = await tx
    .select({
      id: admissions.id,
      status: admissions.status,
      admittedAt: admissions.admittedAt,
      dischargedAt: admissions.dischargedAt,
      encounterId: admissions.encounterId,
    })
    .from(admissions)
    .where(eq(admissions.id, args.admissionId))
    .for('share');
  if (!admission?.admittedAt) return 0;

  const spells = await tx
    .select({
      assignmentId: bedAssignments.id,
      fromAt: bedAssignments.fromAt,
      toAt: bedAssignments.toAt,
      bedLabel: beds.label,
      wardName: wards.name,
      chargeItemId: chargeItems.id,
      chargeName: chargeItems.name,
      pricePaise: chargeItems.sellingPricePaise,
      taxRateBp: chargeItems.taxRateBp,
    })
    .from(bedAssignments)
    .innerJoin(beds, eq(beds.id, bedAssignments.bedId))
    .innerJoin(wards, eq(wards.id, beds.wardId))
    .leftJoin(chargeItems, eq(chargeItems.id, wards.dailyChargeItemId))
    .where(eq(bedAssignments.admissionId, admission.id));
  if (spells.length === 0) return 0;

  const days = chargeableBedDays({
    admittedAt: admission.admittedAt,
    endedAt: args.endedAt === undefined ? admission.dischargedAt : args.endedAt,
    spells,
    now: args.now,
    timezone: args.timezone,
  });
  if (days.length === 0) return 0;

  // Dates already charged on this stay, whichever bed they were charged to.
  const charged = await tx
    .select({ serviceDate: billItems.serviceDate })
    .from(billItems)
    .innerJoin(bills, eq(bills.id, billItems.billId))
    .where(
      and(
        eq(bills.encounterId, admission.encounterId),
        ne(bills.status, 'cancelled'),
        eq(billItems.itemType, 'room'),
        isNotNull(billItems.serviceDate),
        isNull(billItems.voidedAt),
      ),
    );
  const done = new Set(charged.map((row) => row.serviceDate));
  const missing = days.filter((day) => !done.has(day.serviceDate));
  if (missing.length === 0) return 0;

  const [encounter] = await tx.select().from(encounters).where(eq(encounters.id, admission.encounterId));
  const bySpell = new Map(spells.map((spell) => [spell.assignmentId, spell]));
  let added = 0;
  let bill: Awaited<ReturnType<typeof getOrCreateDraftBillInTx>> | null = null;

  for (const day of missing) {
    const spell = bySpell.get(day.assignmentId)!;
    if (!spell.chargeItemId || spell.pricePaise === null) continue;
    bill ??= await getOrCreateDraftBillInTx(tx, { encounter, actorUserId: args.actorUserId ?? null });
    const amounts = calculateBillItem({ quantity: 1, unitPricePaise: spell.pricePaise, taxRateBp: spell.taxRateBp ?? 0 });
    const inserted = await tx
      .insert(billItems)
      .values({
        hospitalId: encounter.hospitalId,
        billId: bill.id,
        itemType: 'room',
        chargeItemId: spell.chargeItemId,
        bedAssignmentId: spell.assignmentId,
        serviceDate: day.serviceDate,
        description: `${spell.chargeName} · ${spell.wardName}, bed ${spell.bedLabel} · ${formatDay(day.serviceDate)}`.slice(0, 200),
        quantity: 1,
        configuredUnitPricePaise: spell.pricePaise,
        unitPricePaise: spell.pricePaise,
        taxRateBp: spell.taxRateBp ?? 0,
        ...amounts,
        createdByUserId: args.actorUserId ?? null,
      })
      .onConflictDoNothing({
        target: [billItems.bedAssignmentId, billItems.serviceDate],
        where: sql`bed_assignment_id is not null and voided_at is null`,
      })
      .returning({ id: billItems.id });
    added += inserted.length;
  }
  return added;
}

/**
 * The sweep: every stay with a patient in a bed, in every hospital (or one).
 * Runs with the admin connection like the other sweeps, one transaction per
 * stay so one problem never blocks the rest.
 */
export async function postBedDayCharges(
  now: Date = new Date(),
  options: { hospitalId?: string } = {},
): Promise<number> {
  const db = getAdminDb();
  const live = await db
    .select({ id: admissions.id, timezone: hospitals.timezone })
    .from(admissions)
    .innerJoin(hospitals, eq(hospitals.id, admissions.hospitalId))
    .where(
      and(
        inArray(admissions.status, ['admitted', 'discharge_ready']),
        options.hospitalId ? eq(admissions.hospitalId, options.hospitalId) : undefined,
      ),
    );

  let added = 0;
  for (const admission of live) {
    try {
      added += await db.transaction((tx) =>
        postBedDaysForAdmissionInTx(tx as unknown as Tx, {
          admissionId: admission.id,
          timezone: admission.timezone,
          now,
        }),
      );
    } catch (error) {
      console.error(`[sweeps] bed-day charge failed for admission ${admission.id}`, error);
    }
  }
  return added;
}
