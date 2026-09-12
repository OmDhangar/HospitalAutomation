import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { appointments, notificationOutbox } from '@/lib/db/schema';
import {
  categoriseMessage,
  type MessageCategory,
} from '@/lib/domain/message-category';
import { messageRatio } from '@/lib/domain/pricing';
import {
  billingPeriod,
  daysUntilExpiry,
  expiryBucket,
  usageAxis,
  type BillingPeriod,
  type ExpiryBucket,
  type UsageAxis,
} from '@/lib/domain/subscription';
import { serviceDateIn } from '@/lib/domain/time';
import { getCurrentSubscription, type Subscription } from './subscriptions';

/**
 * Usage is derived, never accumulated.
 *
 * Every number here is a count over `appointments` and `notification_outbox` —
 * the tables that already record what actually happened. There is no counter to
 * increment, so there is nothing to double-count on a retry, nothing to drift
 * out of step after a crash, and no reset job to run at a period boundary. A
 * recount always produces the same answer.
 */
export type HospitalUsage = {
  subscription: Subscription | null;
  period: BillingPeriod | null;
  /** Appointments completed today against the tier's daily capacity. */
  today: UsageAxis;
  /** Appointments completed this billing period against the monthly allowance. */
  appointments: UsageAxis;
  /** Messages actually sent this period against the message allowance. */
  messages: UsageAxis;
  /** The ratio that governs our margin, surfaced honestly to the hospital too. */
  messagesPerAppointment: number | null;
  expiry: {
    endsAt: Date | null;
    bucket: ExpiryBucket;
    daysRemaining: number | null;
  };
};

const EMPTY_AXIS: UsageAxis = {
  used: 0,
  allowance: 0,
  remaining: 0,
  percent: null,
  level: 'normal',
};

const EMPTY_USAGE: HospitalUsage = {
  subscription: null,
  period: null,
  today: EMPTY_AXIS,
  appointments: EMPTY_AXIS,
  messages: EMPTY_AXIS,
  messagesPerAppointment: null,
  expiry: { endsAt: null, bucket: null, daysRemaining: null },
};

export async function getHospitalUsage(args: {
  hospitalId: string;
  timezone: string;
  now?: Date;
}): Promise<HospitalUsage> {
  const now = args.now ?? new Date();
  const subscription = await getCurrentSubscription(args.hospitalId);

  if (!subscription) {
    return EMPTY_USAGE;
  }

  return withTenant(args.hospitalId, (tx) =>
    getHospitalUsageInTx(tx, { timezone: args.timezone, now, subscription }),
  );
}

/**
 * Runs inside an already-open transaction. The subscription must be
 * pre-fetched by the caller so we do not open a second withTenant.
 *
 * All three count queries run in parallel — they read different tables
 * and do not depend on each other.
 */
export async function getHospitalUsageInTx(
  tx: Tx,
  args: {
    timezone: string;
    now: Date;
    subscription: Subscription;
  },
): Promise<HospitalUsage> {
  const { subscription, now } = args;
  const period = billingPeriod({ startsAt: subscription.startsAt, now });
  const today = serviceDateIn(args.timezone, now);

  const periodStart = period.start.toISOString();
  const periodEnd = period.end.toISOString();

  const [counts] = await tx.execute<{
    today_count: string | number;
    period_count: string | number;
    message_count: string | number;
  }>(sql`
    select 
      (
        select count(*)::int 
        from appointments 
        where service_date = ${today} and status = 'COMPLETED'
      ) as today_count,
      (
        select count(*)::int 
        from appointments 
        where status = 'COMPLETED' and completed_at >= ${periodStart}::timestamptz and completed_at < ${periodEnd}::timestamptz
      ) as period_count,
      (
        select count(*)::int 
        from notification_outbox 
        where status = 'sent' and sent_at >= ${periodStart}::timestamptz and sent_at < ${periodEnd}::timestamptz
      ) as message_count
  `);

  const completedToday = Number(counts?.today_count ?? 0);
  const completedInPeriod = Number(counts?.period_count ?? 0);
  const messagesInPeriod = Number(counts?.message_count ?? 0);

  return {
    subscription,
    period,
    today: usageAxis(completedToday, subscription.dailyAppointmentCapacity),
    appointments: usageAxis(completedInPeriod, subscription.includedAppointments),
    messages: usageAxis(messagesInPeriod, subscription.includedMessages),
    messagesPerAppointment: messageRatio({
      messagesSent: messagesInPeriod,
      completedAppointments: completedInPeriod,
    }),
    expiry: {
      endsAt: subscription.endsAt,
      bucket: expiryBucket(subscription.endsAt, now),
      daysRemaining: daysUntilExpiry(subscription.endsAt, now),
    },
  };
}

export type DailyUsagePoint = {
  date: string;
  appointments: number;
  messages: number;
};

/**
 * A day-by-day series for the usage chart.
 *
 * Appointments are keyed on `service_date` and messages on the day they were
 * sent, which is why this is two queries stitched together rather than one
 * join — joining them would multiply rows and inflate both counts.
 */
export async function getDailyUsageSeries(args: {
  hospitalId: string;
  from: Date;
  to: Date;
}): Promise<DailyUsagePoint[]> {
  return withTenant(args.hospitalId, async (tx) => {
    const appointmentRows = await tx
      .select({
        date: appointments.serviceDate,
        value: count(),
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.status, 'COMPLETED'),
          gte(appointments.completedAt, args.from),
          lt(appointments.completedAt, args.to),
        ),
      )
      .groupBy(appointments.serviceDate);

    const messageRows = await tx
      .select({
        date: sql<string>`to_char(${notificationOutbox.sentAt}, 'YYYY-MM-DD')`,
        value: count(),
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'sent'),
          gte(notificationOutbox.sentAt, args.from),
          lt(notificationOutbox.sentAt, args.to),
        ),
      )
      .groupBy(sql`to_char(${notificationOutbox.sentAt}, 'YYYY-MM-DD')`);

    const byDate = new Map<string, DailyUsagePoint>();
    for (const row of appointmentRows) {
      byDate.set(row.date, {
        date: row.date,
        appointments: Number(row.value),
        messages: 0,
      });
    }
    for (const row of messageRows) {
      const existing = byDate.get(row.date);
      if (existing) existing.messages = Number(row.value);
      else
        byDate.set(row.date, {
          date: row.date,
          appointments: 0,
          messages: Number(row.value),
        });
    }

    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  });
}

export type CategoryUsage = { category: MessageCategory; messages: number };

/** What the hospital's message allowance is actually being spent on. */
export async function getMessageBreakdown(args: {
  hospitalId: string;
  from: Date;
  to: Date;
}): Promise<CategoryUsage[]> {
  const rows = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        templateCode: notificationOutbox.templateCode,
        milestone: notificationOutbox.milestone,
        value: count(),
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'sent'),
          gte(notificationOutbox.sentAt, args.from),
          lt(notificationOutbox.sentAt, args.to),
        ),
      )
      .groupBy(notificationOutbox.templateCode, notificationOutbox.milestone),
  );

  const totals = new Map<MessageCategory, number>();
  for (const row of rows) {
    const category = categoriseMessage({
      templateCode: row.templateCode,
      milestone: row.milestone,
    });
    totals.set(category, (totals.get(category) ?? 0) + Number(row.value));
  }

  return [...totals.entries()]
    .map(([category, messages]) => ({ category, messages }))
    .sort((a, b) => b.messages - a.messages);
}

export type DeliveryStats = {
  sent: number;
  delivered: number;
  failed: number;
  pending: number;
  suppressed: number;
};

/** Delivery outcomes for the period, for the admin hospital detail view. */
export async function getDeliveryStats(args: {
  hospitalId: string;
  from: Date;
  to: Date;
}): Promise<DeliveryStats> {
  const rows = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({ status: notificationOutbox.status, value: count() })
      .from(notificationOutbox)
      .where(
        and(
          gte(notificationOutbox.createdAt, args.from),
          lt(notificationOutbox.createdAt, args.to),
        ),
      )
      .groupBy(notificationOutbox.status),
  );

  const stats: DeliveryStats = {
    sent: 0,
    delivered: 0,
    failed: 0,
    pending: 0,
    suppressed: 0,
  };

  for (const row of rows) {
    const n = Number(row.value);
    if (row.status === 'sent') stats.sent += n;
    else if (row.status === 'failed') stats.failed += n;
    else if (row.status === 'suppressed') stats.suppressed += n;
    else stats.pending += n; // pending and sending are both "not yet away"
  }

  // Delivered is a subset of sent, tracked separately by the webhook receipts.
  const [deliveredRow] = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({ value: count() })
      .from(notificationOutbox)
      .where(
        and(
          sql`${notificationOutbox.deliveredAt} is not null`,
          gte(notificationOutbox.createdAt, args.from),
          lt(notificationOutbox.createdAt, args.to),
        ),
      ),
  );
  stats.delivered = Number(deliveredRow?.value ?? 0);

  return stats;
}
