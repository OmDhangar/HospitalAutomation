import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { admissions, auditLogs, documentSequences } from '@/lib/db/schema';
import { IPD_NUMBER_KIND, IPD_NUMBER_NEVER_RESETS, parseNextIpdNumber } from '@/lib/domain/ipd-number';

/**
 * IPD numbers (lib/domain/ipd-number.ts): given with the first bed, from a
 * per-hospital sequence that never resets and never gives a number twice.
 *
 * The increment is the `document_sequences` upsert the bill numbers use
 * (discharge-billing.ts `nextNumberInTx`): the conflict update locks the row,
 * so two admissions confirmed at the same moment get different numbers.
 */

/** Gives the admission its IPD No. if it has none yet; a second call returns the same number. */
export async function assignIpdNumberInTx(tx: Tx, args: { hospitalId: string; admissionId: string }): Promise<number> {
  const [admission] = await tx
    .select({ ipdNumber: admissions.ipdNumber })
    .from(admissions)
    .where(eq(admissions.id, args.admissionId))
    .for('update');
  if (!admission) throw new Error('admission not found');
  if (admission.ipdNumber !== null) return admission.ipdNumber;

  const [row] = await tx
    .insert(documentSequences)
    .values({ hospitalId: args.hospitalId, kind: IPD_NUMBER_KIND, fiscalYear: IPD_NUMBER_NEVER_RESETS, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [documentSequences.hospitalId, documentSequences.kind, documentSequences.fiscalYear],
      set: { lastNumber: sql`${documentSequences.lastNumber} + 1`, updatedAt: new Date() },
    })
    .returning({ lastNumber: documentSequences.lastNumber });

  await tx.update(admissions).set({ ipdNumber: row.lastNumber }).where(eq(admissions.id, args.admissionId));
  return row.lastNumber;
}

async function readStateInTx(tx: Tx, hospitalId: string) {
  const [[sequence], [given]] = await Promise.all([
    tx
      .select({ lastNumber: documentSequences.lastNumber })
      .from(documentSequences)
      .where(
        and(
          eq(documentSequences.hospitalId, hospitalId),
          eq(documentSequences.kind, IPD_NUMBER_KIND),
          eq(documentSequences.fiscalYear, IPD_NUMBER_NEVER_RESETS),
        ),
      ),
    tx
      .select({ highest: sql<number | null>`max(${admissions.ipdNumber})` })
      .from(admissions)
      .where(eq(admissions.hospitalId, hospitalId)),
  ]);
  return { lastNumber: sequence?.lastNumber ?? 0, highestGiven: Number(given?.highest ?? 0) };
}

/** The sequence and the highest number actually given, for Settings → Letterhead. */
export async function getIpdNumberState(hospitalId: string): Promise<{ lastNumber: number; highestGiven: number; unnumbered: number }> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const state = await readStateInTx(tx, hospitalId);
      const [{ count }] = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(admissions)
        .where(
          and(
            eq(admissions.hospitalId, hospitalId),
            inArray(admissions.status, ['admitted', 'discharge_ready']),
            isNull(admissions.ipdNumber),
          ),
        );
      return { ...state, unnumbered: count };
    },
    { clinical: true },
  );
}

/**
 * The owner sets where numbering continues from (their paper register). Only
 * upwards. Patients in a bed who have no number yet — admitted before IPD
 * numbers existed — are numbered in the same step, oldest admission first.
 */
export async function setNextIpdNumber(args: {
  hospitalId: string;
  next: string;
  actorUserId: string;
}): Promise<{ next: number; numbered: number }> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      // Create the row if needed, then lock it, so a concurrent admission cannot slip in between.
      await tx
        .insert(documentSequences)
        .values({ hospitalId: args.hospitalId, kind: IPD_NUMBER_KIND, fiscalYear: IPD_NUMBER_NEVER_RESETS, lastNumber: 0 })
        .onConflictDoNothing();
      await tx
        .select({ id: documentSequences.id })
        .from(documentSequences)
        .where(
          and(
            eq(documentSequences.hospitalId, args.hospitalId),
            eq(documentSequences.kind, IPD_NUMBER_KIND),
            eq(documentSequences.fiscalYear, IPD_NUMBER_NEVER_RESETS),
          ),
        )
        .for('update');

      const before = await readStateInTx(tx, args.hospitalId);
      const { lastNumber } = parseNextIpdNumber(args.next, before);
      await tx
        .update(documentSequences)
        .set({ lastNumber, updatedAt: new Date() })
        .where(
          and(
            eq(documentSequences.hospitalId, args.hospitalId),
            eq(documentSequences.kind, IPD_NUMBER_KIND),
            eq(documentSequences.fiscalYear, IPD_NUMBER_NEVER_RESETS),
          ),
        );

      const waiting = await tx
        .select({ id: admissions.id })
        .from(admissions)
        .where(
          and(
            eq(admissions.hospitalId, args.hospitalId),
            inArray(admissions.status, ['admitted', 'discharge_ready']),
            isNull(admissions.ipdNumber),
          ),
        )
        .orderBy(asc(admissions.admittedAt), asc(admissions.id));
      for (const admission of waiting) {
        await assignIpdNumberInTx(tx, { hospitalId: args.hospitalId, admissionId: admission.id });
      }

      await tx.insert(auditLogs).values({
        hospitalId: args.hospitalId,
        actorUserId: args.actorUserId,
        action: 'ipd.number_sequence_set',
        objectType: 'document_sequence',
        objectId: IPD_NUMBER_KIND,
        metadata: { from: before.lastNumber, to: lastNumber, numberedNow: waiting.length },
      });
      return { next: lastNumber + 1, numbered: waiting.length };
    },
    { clinical: true },
  );
}
