import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { appointments, hospitals, notificationOutbox, planTiers } from '@/lib/db/schema';
import {
  calculateMonthlyBill,
  messageRatio,
  ratioStatus,
  type RatioStatus,
} from '@/lib/domain/pricing';

export type HospitalHealth = {
  hospitalId: string;
  name: string;
  planCode: string | null;
  includedAppointments: number | null;
  monthlyPricePaise: number | null;
  completedAppointments: number;
  messagesSent: number;
  ratio: number | null;
  status: RatioStatus;
  /** What this hospital is estimated to cost us in messaging this month. */
  messagingCostPaise: number;
  contributionPaise: number | null;
};

/**
 * Roughly what one WhatsApp message costs, in paise.
 *
 * Meta's India utility/authentication rate plus a margin for BSP fees and the
 * October 2026 change that made service messages billable. This is a planning
 * figure held in one place on purpose: when the real rate card lands, it
 * changes here and every projection moves with it.
 */
export const PAISE_PER_MESSAGE = 14.5;

/**
 * The operator's view across every hospital.
 *
 * Cross-tenant by necessity, which is why it runs on the admin connection and
 * why the page above it is gated on isPlatformAdmin. A hospital owner must
 * never see this: it contains other hospitals' numbers and our own margins.
 */
export async function getPortfolioHealth(month?: string): Promise<HospitalHealth[]> {
  const db = getAdminDb();
  const now = new Date();
  const start = month
    ? new Date(`${month}-01T00:00:00Z`)
    : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const rows = await db
    .select({
      hospitalId: hospitals.id,
      name: hospitals.name,
      planCode: hospitals.planTierCode,
      includedAppointments: planTiers.includedAppointments,
      monthlyPricePaise: planTiers.monthlyPricePaise,
    })
    .from(hospitals)
    .leftJoin(planTiers, eq(planTiers.code, hospitals.planTierCode))
    .where(eq(hospitals.active, true))
    .orderBy(hospitals.name);

  return Promise.all(
    rows.map(async (row) => {
      const [completed] = await db
        .select({ value: count() })
        .from(appointments)
        .where(
          and(
            eq(appointments.hospitalId, row.hospitalId),
            eq(appointments.status, 'COMPLETED'),
            gte(appointments.completedAt, start),
          ),
        );

      const [messages] = await db
        .select({ value: count() })
        .from(notificationOutbox)
        .where(
          and(
            eq(notificationOutbox.hospitalId, row.hospitalId),
            eq(notificationOutbox.status, 'sent'),
            gte(notificationOutbox.sentAt, start),
          ),
        );

      const completedAppointments = Number(completed?.value ?? 0);
      const messagesSent = Number(messages?.value ?? 0);
      const ratio = messageRatio({ messagesSent, completedAppointments });
      const messagingCostPaise = Math.round(messagesSent * PAISE_PER_MESSAGE);

      const bill =
        row.planCode && row.includedAppointments && row.monthlyPricePaise
          ? calculateMonthlyBill({
              tier: {
                code: row.planCode,
                name: row.planCode,
                includedAppointments: row.includedAppointments,
                monthlyPricePaise: row.monthlyPricePaise,
              },
              completedAppointments,
            })
          : null;

      return {
        hospitalId: row.hospitalId,
        name: row.name,
        planCode: row.planCode,
        includedAppointments: row.includedAppointments,
        monthlyPricePaise: row.monthlyPricePaise,
        completedAppointments,
        messagesSent,
        ratio,
        status: ratioStatus(ratio),
        messagingCostPaise,
        contributionPaise: bill ? bill.totalPaise - messagingCostPaise : null,
      };
    }),
  );
}

export type RecentFailure = {
  id: string;
  hospitalName: string;
  milestone: string;
  attempts: number;
  failedReason: string | null;
  createdAt: Date;
};

/** Delivery problems worth a human look, newest first. */
export async function getRecentFailures(limit = 20): Promise<RecentFailure[]> {
  const rows = await getAdminDb()
    .select({
      id: notificationOutbox.id,
      hospitalName: hospitals.name,
      milestone: notificationOutbox.milestone,
      attempts: notificationOutbox.attempts,
      failedReason: notificationOutbox.failedReason,
      createdAt: notificationOutbox.createdAt,
      status: notificationOutbox.status,
    })
    .from(notificationOutbox)
    .innerJoin(hospitals, eq(hospitals.id, notificationOutbox.hospitalId))
    .where(sql`${notificationOutbox.status} in ('failed', 'suppressed')`)
    .orderBy(desc(notificationOutbox.createdAt))
    .limit(limit);

  return rows.map(({ status: _status, ...row }) => row);
}
