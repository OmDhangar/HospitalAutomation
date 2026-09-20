import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import {
  appointments,
  doctors,
  notificationOutbox,
  planTiers,
  usageRecords,
} from '@/lib/db/schema';
import {
  calculateMonthlyBill,
  messageRatio,
  ratioStatus,
  type Bill,
  type RatioStatus,
} from '@/lib/domain/pricing';

export type MonthlyUsage = {
  periodMonth: string;
  completedAppointments: number;
  messagesSent: number;
  ratio: number | null;
  ratioStatus: RatioStatus;
  bill: Bill | null;
  planCode: string | null;
};

const monthBounds = (month: string) => {
  const start = new Date(`${month}-01T00:00:00Z`);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
};

/** First day of the current month, as YYYY-MM-01. */
export const currentMonth = (at: Date = new Date()): string =>
  `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/**
 * The billing and margin view for one hospital-month.
 *
 * Both numbers come from operational tables rather than a counter, so an
 * invoice is reproducible from the records that produced it — which is the
 * whole point of metering it this way.
 */
export async function getMonthlyUsage(args: {
  hospitalId: string;
  month?: string;
  planCode?: string | null;
}): Promise<MonthlyUsage> {
  const month = args.month ?? currentMonth();
  const { start, end } = monthBounds(month);

  return withTenant(args.hospitalId, async (tx) => {
    const [completed] = await tx
      .select({ value: count() })
      .from(appointments)
      .where(
        and(
          eq(appointments.status, 'COMPLETED'),
          gte(appointments.completedAt, start),
          lt(appointments.completedAt, end),
        ),
      );

    const [messages] = await tx
      .select({ value: count() })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.status, 'sent'),
          gte(notificationOutbox.sentAt, start),
          lt(notificationOutbox.sentAt, end),
        ),
      );

    const completedAppointments = Number(completed?.value ?? 0);
    const messagesSent = Number(messages?.value ?? 0);
    const ratio = messageRatio({ messagesSent, completedAppointments });

    let bill: Bill | null = null;
    if (args.planCode) {
      const [tier] = await tx
        .select()
        .from(planTiers)
        .where(eq(planTiers.code, args.planCode));

      if (tier) {
        // The row already matches PlanTier field for field; rebuilding a subset
        // of it is how the two drifted apart last time.
        bill = calculateMonthlyBill({
          tier,
          completedAppointments,
          messagesSent,
        });
      }
    }

    return {
      periodMonth: month,
      completedAppointments,
      messagesSent,
      ratio,
      ratioStatus: ratioStatus(ratio),
      bill,
      planCode: args.planCode ?? null,
    };
  });
}

/** Snapshots the month into usage_records so an invoice can be reconstructed. */
export async function recordMonthlyUsage(args: {
  hospitalId: string;
  month?: string;
  planCode: string;
}) {
  const usage = await getMonthlyUsage(args);

  return withTenant(args.hospitalId, (tx) =>
    tx
      .insert(usageRecords)
      .values({
        hospitalId: args.hospitalId,
        periodMonth: `${usage.periodMonth}-01`,
        planTierCode: args.planCode,
        completedAppointments: usage.completedAppointments,
        messagesSent: usage.messagesSent,
      })
      .onConflictDoUpdate({
        target: [usageRecords.hospitalId, usageRecords.periodMonth],
        set: {
          completedAppointments: usage.completedAppointments,
          messagesSent: usage.messagesSent,
          computedAt: new Date(),
        },
      }),
  );
}

export type DoctorDayStat = {
  doctorId: string;
  doctorName: string;
  completed: number;
  noShows: number;
  medianConsultMinutes: number | null;
  medianWaitMinutes: number | null;
};

/**
 * The operational numbers a hospital owner actually cares about: how many
 * patients were seen, how long they waited, and how many never turned up.
 */
export async function getDoctorDayStats(args: {
  hospitalId: string;
  serviceDate: string;
}): Promise<DoctorDayStat[]> {
  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx
      .select({
        doctorId: doctors.id,
        doctorName: doctors.name,
        completed: sql<number>`count(*) filter (where ${appointments.status} = 'COMPLETED')`,
        noShows: sql<number>`count(*) filter (where ${appointments.status} = 'NO_SHOW')`,
        medianConsult: sql<number | null>`
          percentile_cont(0.5) within group (
            order by extract(epoch from (${appointments.completedAt} - ${appointments.consultStartedAt})) / 60
          ) filter (where ${appointments.completedAt} is not null
                      and ${appointments.consultStartedAt} is not null)
        `,
        medianWait: sql<number | null>`
          percentile_cont(0.5) within group (
            order by extract(epoch from (${appointments.calledAt} - ${appointments.enqueuedAt})) / 60
          ) filter (where ${appointments.calledAt} is not null
                      and ${appointments.enqueuedAt} is not null)
        `,
      })
      .from(doctors)
      .leftJoin(
        appointments,
        and(
          eq(appointments.doctorId, doctors.id),
          eq(appointments.serviceDate, args.serviceDate),
        ),
      )
      .groupBy(doctors.id, doctors.name);

    return rows.map((row) => ({
      doctorId: row.doctorId,
      doctorName: row.doctorName,
      completed: Number(row.completed ?? 0),
      noShows: Number(row.noShows ?? 0),
      medianConsultMinutes:
        row.medianConsult === null ? null : Math.round(Number(row.medianConsult)),
      medianWaitMinutes: row.medianWait === null ? null : Math.round(Number(row.medianWait)),
    }));
  });
}

/* ------------------------------------------------------------ trends */

export type DailyTrendPoint = {
  serviceDate: string;
  completed: number;
  noShows: number;
  medianWaitMinutes: number | null;
};

/**
 * Daily volume and waiting time over a window of days.
 *
 * The reports page had no query like this, which is the real reason it read as
 * a data dump rather than a report: a single day's numbers cannot answer any
 * question worth asking. "Forty-two patients today" means nothing without last
 * Tuesday to compare it against, and a median wait of eighteen minutes is only
 * alarming or fine relative to where it has been.
 *
 * Generated from a date series rather than from the appointments themselves, so
 * a day with no OPD appears as a zero instead of vanishing — a gap in a trend
 * line is read as "nothing happened", and a missing day is read as nothing at
 * all.
 */
export async function getDailyTrend(args: {
  hospitalId: string;
  days?: number;
  endDate: string;
}): Promise<DailyTrendPoint[]> {
  const days = args.days ?? 30;

  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx.execute<{
      service_date: string;
      completed: number;
      no_shows: number;
      median_wait: number | null;
    }>(sql`
      with span as (
        select generate_series(
          ${args.endDate}::date - ${days - 1}::int,
          ${args.endDate}::date,
          '1 day'::interval
        )::date as service_date
      )
      select
        span.service_date::text as service_date,
        count(a.id) filter (where a.status = 'COMPLETED')::int as completed,
        count(a.id) filter (where a.status = 'NO_SHOW')::int as no_shows,
        percentile_cont(0.5) within group (
          order by extract(epoch from (a.called_at - a.enqueued_at)) / 60
        ) filter (where a.called_at is not null and a.enqueued_at is not null)
          as median_wait
      from span
      left join appointments a on a.service_date = span.service_date
      group by span.service_date
      order by span.service_date
    `);

    return rows.map((row) => ({
      serviceDate: row.service_date,
      completed: Number(row.completed ?? 0),
      noShows: Number(row.no_shows ?? 0),
      medianWaitMinutes:
        row.median_wait === null ? null : Math.round(Number(row.median_wait)),
    }));
  });
}

export type HourlyLoadPoint = { hour: number; arrivals: number };

/**
 * When patients actually turn up, by hour of the clinic's own day.
 *
 * The most directly actionable number the platform holds. A clinic that sees
 * its arrivals pile into one hour can move a doctor's start time or open slot
 * bookings across the shoulder hours, and the waiting room empties — without
 * buying anything or hiring anyone.
 *
 * Bucketed in the hospital's timezone rather than UTC. At IST's +5:30 offset a
 * UTC bucket would smear every hour across two, which would make the busiest
 * hour of an Indian OPD land in the middle of the night.
 */
export async function getHourlyLoad(args: {
  hospitalId: string;
  timezone: string;
  days?: number;
  endDate: string;
}): Promise<HourlyLoadPoint[]> {
  const days = args.days ?? 30;

  return withTenant(args.hospitalId, async (tx) => {
    const rows = await tx.execute<{ hour: number; arrivals: number }>(sql`
      select
        extract(hour from (a.enqueued_at at time zone ${args.timezone}))::int as hour,
        count(*)::int as arrivals
      from appointments a
      where a.enqueued_at is not null
        and a.service_date > ${args.endDate}::date - ${days}::int
        and a.service_date <= ${args.endDate}::date
      group by 1
      order by 1
    `);

    // Zero-fill so the shape of the clinic day is visible, including the hours
    // nobody arrives in — an absent bar and a zero bar mean different things.
    const byHour = new Map(rows.map((r) => [Number(r.hour), Number(r.arrivals)]));
    return Array.from({ length: 24 }, (_, hour) => ({
      hour,
      arrivals: byHour.get(hour) ?? 0,
    }));
  });
}
