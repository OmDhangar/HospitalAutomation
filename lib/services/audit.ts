import { desc, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { appointments, auditLogs, patients, queueEvents, users } from '@/lib/db/schema';

export type QueueEventRow = {
  id: string;
  action: string;
  fromStatus: string;
  toStatus: string;
  tokenNumber: number | null;
  patientName: string | null;
  actorName: string | null;
  createdAt: Date;
};

/**
 * The answer to "who moved this token, and when".
 *
 * This is the question a hospital actually asks when a patient complains, and
 * it is why queue history is append-only. Joining the actor in matters: an
 * event without a name attached settles nothing.
 */
export async function listQueueEvents(args: {
  hospitalId: string;
  limit?: number;
}): Promise<QueueEventRow[]> {
  return withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: queueEvents.id,
        action: queueEvents.action,
        fromStatus: queueEvents.fromStatus,
        toStatus: queueEvents.toStatus,
        tokenNumber: appointments.tokenNumber,
        patientName: patients.name,
        actorName: users.name,
        createdAt: queueEvents.createdAt,
      })
      .from(queueEvents)
      .leftJoin(appointments, eq(appointments.id, queueEvents.appointmentId))
      .leftJoin(patients, eq(patients.id, appointments.patientId))
      .leftJoin(users, eq(users.id, queueEvents.actorUserId))
      .orderBy(desc(queueEvents.createdAt))
      .limit(args.limit ?? 100),
  );
}

export type AuditRow = {
  id: string;
  action: string;
  objectType: string;
  objectId: string | null;
  actorName: string | null;
  createdAt: Date;
};

/** Sign-ins, role changes, configuration changes, exports. */
export async function listAuditLogs(args: {
  hospitalId: string;
  limit?: number;
}): Promise<AuditRow[]> {
  return withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        objectType: auditLogs.objectType,
        objectId: auditLogs.objectId,
        actorName: users.name,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(args.limit ?? 100),
  );
}
