import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { clinicalAlerts, users } from '@/lib/db/schema';

export type AlertType = (typeof clinicalAlerts.$inferInsert)['type'];
export type AlertStatus = (typeof clinicalAlerts.$inferInsert)['status'];

export type CreateAlertInTxArgs = {
  hospitalId: string;
  branchId: string;
  type: AlertType;
  subjectType: string;
  subjectId: string;
  recipientUserId?: string | null;
  recipientRole?: 'doctor' | 'nurse' | 'receptionist' | 'owner' | null;
  title: string;
  message: string;
  metadata: {
    admissionId: string;
    patientName: string;
    ipdNumber?: number | null;
    bedLabel: string;
    wardName: string;
    urgency?: string;
    isMlc?: boolean;
    [key: string]: unknown;
  };
  escalateAfterMinutes?: number;
};

export async function createClinicalAlertInTx(
  tx: Tx,
  args: CreateAlertInTxArgs,
): Promise<string> {
  const [row] = await tx
    .insert(clinicalAlerts)
    .values({
      hospitalId: args.hospitalId,
      branchId: args.branchId,
      type: args.type,
      subjectType: args.subjectType,
      subjectId: args.subjectId,
      recipientUserId: args.recipientUserId ?? null,
      recipientRole: args.recipientRole ?? null,
      title: args.title,
      message: args.message,
      metadata: args.metadata,
      status: 'pending',
      escalateAfterMinutes: args.escalateAfterMinutes ?? 20,
    })
    .returning({ id: clinicalAlerts.id });

  return row.id;
}

export async function acknowledgeClinicalAlert(args: {
  hospitalId: string;
  alertId: string;
  actorUserId: string;
}): Promise<void> {
  await withTenant(
    args.hospitalId,
    async (tx) => {
      const now = new Date();
      await tx
        .update(clinicalAlerts)
        .set({
          status: 'acknowledged',
          acknowledgedAt: now,
          acknowledgedByUserId: args.actorUserId,
        })
        .where(
          and(
            eq(clinicalAlerts.hospitalId, args.hospitalId),
            eq(clinicalAlerts.id, args.alertId),
          ),
        );
    },
    { clinical: true },
  );
}

export async function sweepPendingAlerts(hospitalId: string): Promise<{ escalatedCount: number }> {
  return withTenant(
    hospitalId,
    async (tx) => {
      const now = new Date();
      // Find pending alerts exceeding escalateAfterMinutes
      const expiredAlerts = await tx
        .select({ id: clinicalAlerts.id, escalateAfterMinutes: clinicalAlerts.escalateAfterMinutes })
        .from(clinicalAlerts)
        .where(
          and(
            eq(clinicalAlerts.hospitalId, hospitalId),
            eq(clinicalAlerts.status, 'pending'),
            sql`${clinicalAlerts.createdAt} + make_interval(mins => ${clinicalAlerts.escalateAfterMinutes}) <= ${now}`,
          ),
        );

      if (expiredAlerts.length === 0) return { escalatedCount: 0 };

      const ids = expiredAlerts.map((a) => a.id);
      await tx
        .update(clinicalAlerts)
        .set({
          status: 'escalated',
          escalatedAt: now,
          escalatedToRole: 'nurse', // Escalates to Nursing In-charge
        })
        .where(
          and(
            eq(clinicalAlerts.hospitalId, hospitalId),
            inArray(clinicalAlerts.id, ids),
          ),
        );

      return { escalatedCount: ids.length };
    },
    { clinical: true },
  );
}

export async function getActiveAlertsForUser(args: {
  hospitalId: string;
  userId: string;
  role?: string;
}): Promise<Array<typeof clinicalAlerts.$inferSelect>> {
  return withTenant(
    args.hospitalId,
    async (tx) => {
      return tx
        .select()
        .from(clinicalAlerts)
        .where(
          and(
            eq(clinicalAlerts.hospitalId, args.hospitalId),
            inArray(clinicalAlerts.status, ['pending', 'escalated']),
            or(
              eq(clinicalAlerts.recipientUserId, args.userId),
              and(isNull(clinicalAlerts.recipientUserId), args.role ? eq(clinicalAlerts.recipientRole, args.role as any) : undefined),
            ),
          ),
        )
        .orderBy(desc(clinicalAlerts.createdAt))
        .limit(10);
    },
    { clinical: true },
  );
}
