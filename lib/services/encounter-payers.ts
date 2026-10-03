import { and, eq, isNull } from 'drizzle-orm';
import type { Tx } from '@/lib/db';
import { auditLogs, encounterPayers } from '@/lib/db/schema';
import type { PayerInput } from '@/lib/domain/payer';
import type { EncounterRow } from '@/lib/services/encounters';

/**
 * Who pays for an encounter. One active row at a time; a change voids the
 * old row and inserts a new one (the table is void-only by trigger), so the
 * history of "self, then the insurer approved" is kept.
 */

export type PayerRow = typeof encounterPayers.$inferSelect;

export async function getActivePayerInTx(tx: Tx, encounterId: string): Promise<PayerRow | null> {
  const [row] = await tx
    .select()
    .from(encounterPayers)
    .where(and(eq(encounterPayers.encounterId, encounterId), isNull(encounterPayers.voidedAt)));
  return row ?? null;
}

/**
 * Records the payer. Writing the same thing again is a no-op, so the
 * admission sheet can always send the payer block without creating noise.
 */
export async function setPayerInTx(
  tx: Tx,
  args: {
    encounter: Pick<EncounterRow, 'id' | 'hospitalId' | 'patientId'>;
    payer: PayerInput;
    approvedAmountPaise?: number | null;
    actorUserId: string;
    reason?: string;
  },
): Promise<PayerRow> {
  const current = await getActivePayerInTx(tx, args.encounter.id);
  const approved = args.approvedAmountPaise ?? current?.approvedAmountPaise ?? null;
  if (
    current &&
    current.kind === args.payer.kind &&
    current.payerName === args.payer.payerName &&
    current.policyNumber === args.payer.policyNumber &&
    current.preauthAmountPaise === args.payer.preauthAmountPaise &&
    current.approvedAmountPaise === approved
  ) {
    return current;
  }

  if (current) {
    await tx
      .update(encounterPayers)
      .set({ voidedAt: new Date(), voidedByUserId: args.actorUserId, voidReason: args.reason ?? 'Payer changed' })
      .where(eq(encounterPayers.id, current.id));
  }
  const [row] = await tx
    .insert(encounterPayers)
    .values({
      hospitalId: args.encounter.hospitalId,
      encounterId: args.encounter.id,
      patientId: args.encounter.patientId,
      kind: args.payer.kind,
      payerName: args.payer.payerName,
      policyNumber: args.payer.policyNumber,
      preauthAmountPaise: args.payer.preauthAmountPaise,
      approvedAmountPaise: args.payer.kind === 'self' ? null : approved,
      createdByUserId: args.actorUserId,
    })
    .returning();

  await tx.insert(auditLogs).values({
    hospitalId: args.encounter.hospitalId,
    actorUserId: args.actorUserId,
    action: 'ipd.payer_set',
    objectType: 'encounter',
    objectId: args.encounter.id,
    metadata: { kind: row.kind, payerName: row.payerName, previous: current?.kind ?? null },
  });
  return row;
}
