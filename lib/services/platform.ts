import { and, count, desc, eq, gte, sql } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import {
  appointments,
  hospitals,
  notificationOutbox,
  planTiers,
  providerInvoices,
} from '@/lib/db/schema';
import {
  calculateMonthlyBill,
  messageRatio,
  ratioStatus,
  recommendTier,
  type PlanTier,
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
  /**
   * The tier this hospital's actual volume says they belong on. When it differs
   * from what they pay for, that is either revenue being left on the table or a
   * customer about to be surprised by overage — both worth a call.
   */
  recommendedTierCode: string | null;
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
 * What a message actually cost last time Meta billed us, or the planning figure
 * if no invoice has been recorded yet.
 *
 * Worth reconciling rather than assuming: Meta's utility rate drops with
 * monthly volume, so the true cost per message falls as the portfolio grows.
 * Using a flat estimate understates margin at scale and overstates it if rates
 * rise — either way it is a guess where a fact is available.
 */
export async function resolvePaisePerMessage(
  month?: string,
): Promise<{ paise: number; source: 'invoice' | 'estimate'; month?: string }> {
  const rows = await getAdminDb()
    .select({
      periodMonth: providerInvoices.periodMonth,
      messagesBilled: providerInvoices.messagesBilled,
      amountPaise: providerInvoices.amountPaise,
    })
    .from(providerInvoices)
    .orderBy(desc(providerInvoices.periodMonth))
    .limit(1);

  const latest = rows[0];
  if (!latest || latest.messagesBilled <= 0) {
    return { paise: PAISE_PER_MESSAGE, source: 'estimate' };
  }

  return {
    paise: latest.amountPaise / latest.messagesBilled,
    source: 'invoice',
    month: String(latest.periodMonth),
  };
}

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

  const rate = (await resolvePaisePerMessage(month)).paise;
  // Recommendations come from the live rate card, not the seeded constants, so
  // a price negotiated in the database is respected here too.
  const allTiers = (await db.select().from(planTiers)) as PlanTier[];

  const rows = await db
    .select({
      hospitalId: hospitals.id,
      name: hospitals.name,
      planCode: hospitals.planTierCode,
      tier: planTiers,
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
      const messagingCostPaise = Math.round(messagesSent * rate);

      const bill = row.tier
        ? calculateMonthlyBill({
            tier: row.tier,
            completedAppointments,
            messagesSent,
          })
        : null;

      return {
        hospitalId: row.hospitalId,
        name: row.name,
        planCode: row.planCode,
        includedAppointments: row.tier?.includedAppointments ?? null,
        monthlyPricePaise: row.tier?.monthlyPricePaise ?? null,
        completedAppointments,
        messagesSent,
        ratio,
        status: ratioStatus(ratio),
        messagingCostPaise,
        contributionPaise: bill ? bill.totalPaise - messagingCostPaise : null,
        recommendedTierCode:
          completedAppointments > 0
            ? (recommendTier(completedAppointments, allTiers)?.code ?? null)
            : null,
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
