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
