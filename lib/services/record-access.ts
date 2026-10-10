import { and, eq, gt, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { recordAccessLogs } from '@/lib/db/schema';
import { isRequestReadOnly, requestOrigin } from '@/lib/db/request-context';

/**
 * Logs a read of a patient's record (DPDP; IPD sheets plan §6.2.3).
 *
 * `dedupeMinutes` keeps a nurse who moves between a patient's sheets, or
 * refreshes one, from writing a row per click: the read is logged once per
 * actor, patient and action in that window. Prints and staff-timeline views
 * pass no dedupe — every one is logged.
 *
 * A support (read-only) session cannot read clinical rows at all, and cannot
 * write; it is not logged here.
 */

export type RecordAccessAction = (typeof recordAccessLogs.$inferInsert)['action'];

export async function logRecordAccessInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    actorUserId: string;
    patientId: string;
    encounterId: string | null;
    action: RecordAccessAction;
    dedupeMinutes?: number;
  },
): Promise<boolean> {
  if (args.dedupeMinutes) {
    const [recent] = await tx
      .select({ id: recordAccessLogs.id })
      .from(recordAccessLogs)
      .where(
        and(
          eq(recordAccessLogs.patientId, args.patientId),
          eq(recordAccessLogs.actorUserId, args.actorUserId),
          eq(recordAccessLogs.action, args.action),
          gt(recordAccessLogs.createdAt, sql`now() - make_interval(mins => ${args.dedupeMinutes})`),
        ),
      )
      .limit(1);
    if (recent) return false;
  }
  const origin = await requestOrigin();
  await tx.insert(recordAccessLogs).values({
    hospitalId: args.hospitalId,
    actorUserId: args.actorUserId,
    patientId: args.patientId,
    encounterId: args.encounterId,
    action: args.action,
    // The session and device of this request (0042), when it has them.
    sessionId: origin?.sessionId ?? null,
    deviceId: origin?.deviceId ?? null,
  });
  return true;
}

export async function logRecordAccess(args: Parameters<typeof logRecordAccessInTx>[1]): Promise<boolean> {
  if (await isRequestReadOnly()) return false;
  return withTenant(args.hospitalId, (tx) => logRecordAccessInTx(tx, args));
}
