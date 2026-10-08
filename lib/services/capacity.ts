import { and, eq, notInArray, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { appointments, auditLogs, doctorDayStates, doctors, subscriptions } from '@/lib/db/schema';
import {
  dayCapacitySummary,
  decideAllocation,
  exceedsPlanCapacity,
  planCapacityViolation,
  validateCapacityConfig,
  type AllocationDecision,
  type CapacityChannel,
  type CapacityConfig,
  type DayCapacityState,
  type DayCapacitySummary,
  type QuotaPool,
} from '@/lib/domain/capacity';
import { dayStartAt, isLiveQueueOpen } from '@/lib/domain/sessions';
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import { lockDoctorDay, type DoctorDayState } from './doctor-day';
import { loadDaySessionsInTx, resolveScheduledStartInTx } from './scheduling';

/** Statuses that no longer count against the day's quota. */
const RELEASED_STATUSES = ['CANCELLED', 'EXPIRED', 'NO_SHOW'] as const;

export type CapacityErrorCode =
  | 'ONLINE_NOT_OPEN'
  | 'QUOTA_REACHED'
  | 'FULLY_BOOKED'
  | 'EXTRA_NOT_NEEDED'
  /** A hybrid day after its live-queue session: only evening slots remain. */
  | 'QUEUE_CLOSED';

/** A booking refused by the quota. The message is safe to show a patient or the desk. */
export class CapacityError extends Error {
  constructor(
    readonly code: CapacityErrorCode,
    message: string,
    readonly opensAt: Date | null = null,
  ) {
    super(message);
    this.name = 'CapacityError';
  }
}

export type AllocatedToken = { tokenNumber: number; pool: QuotaPool | null };

/**
 * The doctor's standing capacity settings, read live.
 *
 * There is no per-day copy. Days used to snapshot these at their first token
 * and never look again, so a day that had issued anything before the admin set
 * or raised the reserve — an advance slot booking made weeks earlier was
 * enough — ran with the old numbers all day, and online patients took tokens
 * 1, 2, 3 out of a reserve that existed only on the settings page.
 */
async function loadDoctorCapacityConfig(tx: Tx, doctorId: string) {
  const [doctor] = await tx
    .select({
      quota: doctors.dailyTokenQuota,
      walkInReserved: doctors.walkInReserved,
      opens: doctors.onlineOpensMinutesBefore,
      release: doctors.walkInReleaseMinutes,
    })
    .from(doctors)
    .where(eq(doctors.id, doctorId));
  return doctor ?? null;
}

/**
 * Active appointments per pool for one doctor-day. Must run after the lock.
 * Tokens issued while no capacity rule applied have no pool and count as shared.
 */
async function countActiveByPool(tx: Tx, doctorId: string, serviceDate: string) {
  const pool = sql<QuotaPool>`coalesce(${appointments.quotaPool}, 'shared')`;
  const rows = await tx
    .select({ pool, n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        eq(appointments.serviceDate, serviceDate),
        notInArray(appointments.status, [...RELEASED_STATUSES]),
      ),
    )
    .groupBy(pool);
  const get = (p: QuotaPool) => rows.find((r) => r.pool === p)?.n ?? 0;
  return { reservedActive: get('reserved'), sharedActive: get('shared'), extraActive: get('extra') };
}

/**
 * Numbers already issued above the last reserved token but inside the reserve.
 * Non-empty only after the reserve was raised mid-day; read for walk-ins only.
 */
async function reservedRangeTaken(tx: Tx, day: DoctorDayState, walkInReserved: number): Promise<number[]> {
  if (walkInReserved <= day.lastReservedToken || day.lastTokenNumber <= day.lastReservedToken) return [];
  const rows = await tx
    .select({ n: appointments.tokenNumber })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, day.doctorId),
        eq(appointments.serviceDate, day.serviceDate),
        sql`${appointments.tokenNumber} > ${day.lastReservedToken}`,
        sql`${appointments.tokenNumber} <= ${walkInReserved}`,
      ),
    );
  return rows.map((r) => r.n);
}

/**
 * Today's capacity picture from the doctor's live settings, or null when the
 * doctor has neither a quota nor a reserve (tokens then issue from one plain
 * counter, as before capacity existed).
 */
async function loadDayCapacityState(
  tx: Tx,
  day: DoctorDayState | undefined,
  args: {
    doctorId: string;
    serviceDate: string;
    timezone: string;
    channel?: CapacityChannel;
    /** Already resolved by the caller; looked up when absent. */
    scheduledStartAt?: Date | null;
  },
): Promise<DayCapacityState | null> {
  const config = await loadDoctorCapacityConfig(tx, args.doctorId);
  if (!config || (config.quota === null && config.walkInReserved <= 0)) return null;

  const walkInReserved =
    config.quota === null ? config.walkInReserved : Math.min(config.walkInReserved, config.quota);
  const [counts, scheduledStartAt, taken] = await Promise.all([
    countActiveByPool(tx, args.doctorId, args.serviceDate),
    args.scheduledStartAt !== undefined
      ? Promise.resolve(args.scheduledStartAt)
      : resolveScheduledStartInTx(tx, { ...args, dayOverride: day?.scheduledStartAt }),
    day && args.channel === 'walk_in' ? reservedRangeTaken(tx, day, walkInReserved) : Promise.resolve([]),
  ]);
  return {
    quota: config.quota === null ? null : config.quota + (day?.extraCapacity ?? 0),
    walkInReserved,
    onlineOpensMinutesBefore: config.opens,
    walkInReleaseMinutes: config.release,
    reservedReleasedAt: day?.reservedReleasedAt ?? null,
    sessionStartedAt: day?.sessionStartedAt ?? null,
    scheduledStartAt,
    lastReservedToken: day?.lastReservedToken ?? 0,
    lastToken: day?.lastTokenNumber ?? 0,
    reservedRangeTaken: taken,
    ...counts,
  };
}

function refusal(decision: Exclude<AllocationDecision, { ok: true }>, timezone: string): CapacityError {
  switch (decision.reason) {
    case 'online_not_open':
      return new CapacityError(
        'ONLINE_NOT_OPEN',
        `Online booking for today opens at ${formatTimeIn(timezone, decision.opensAt)}.`,
        decision.opensAt,
      );
    case 'quota_reached':
      return new CapacityError(
        'QUOTA_REACHED',
        "Today's token quota is full. The owner can issue an extra token if the patient must be seen.",
      );
    case 'fully_booked':
      return new CapacityError('FULLY_BOOKED', 'Fully booked for today. Please visit the hospital or try another day.');
    case 'extra_not_needed':
      return new CapacityError(
        'EXTRA_NOT_NEEDED',
        "Today's quota is not full yet, so an extra token is not needed. Add the patient normally.",
      );
  }
}

/**
 * Issues the next token for a doctor-day — the one place a token number is
 * chosen.
 *
 * Takes the doctor-day lock, so concurrent bookings serialise: two patients
 * can never share a token, and the last free place goes to exactly one of
 * them. Counts are read after the lock, in a fresh statement, so they include
 * everything committed before us. Without a quota, behaves exactly as before:
 * one counter, no limit.
 */
export async function allocateTokenInTx(
  tx: Tx,
  args: {
    hospitalId: string;
    doctorId: string;
    serviceDate: string;
    timezone: string;
    channel: CapacityChannel;
    now: Date;
  },
): Promise<AllocatedToken> {
  const day = await lockDoctorDay(tx, args);
  const isSameDay = args.serviceDate === serviceDateIn(args.timezone, args.now);

  // On a hybrid day the live queue closes when its session ends; the evening
  // is booked slots only. An owner's deliberate extra token still goes through.
  const sessions = await loadDaySessionsInTx(tx, args);
  if (isSameDay && (args.channel === 'walk_in' || args.channel === 'online') && !isLiveQueueOpen(sessions, args.now)) {
    throw new CapacityError(
      'QUEUE_CLOSED',
      "Today's live queue has closed. Please book a time slot in the evening session.",
    );
  }

  const state = await loadDayCapacityState(tx, day, {
    ...args,
    scheduledStartAt: day.scheduledStartAt ?? dayStartAt(sessions),
  });
  if (!state) {
    // Past any reserved numbers issued while a reserve was configured earlier today.
    const tokenNumber = Math.max(day.lastTokenNumber, day.lastReservedToken) + 1;
    await tx
      .update(doctorDayStates)
      .set({ lastTokenNumber: tokenNumber, updatedAt: args.now })
      .where(eq(doctorDayStates.id, day.id));
    return { tokenNumber, pool: null };
  }

  const decision = decideAllocation(state, args.channel, args.now, { isSameDay });
  if (!decision.ok) throw refusal(decision, args.timezone);

  await tx
    .update(doctorDayStates)
    .set(
      decision.pool === 'reserved'
        ? { lastReservedToken: decision.tokenNumber, updatedAt: args.now }
        : { lastTokenNumber: decision.tokenNumber, updatedAt: args.now },
    )
    .where(eq(doctorDayStates.id, day.id));

  return { tokenNumber: decision.tokenNumber, pool: decision.pool };
}

/** Today's capacity picture for one doctor, or null when the doctor has no quota or reserve. */
export async function getDayCapacityInTx(
  tx: Tx,
  args: { doctorId: string; serviceDate: string; timezone: string; now: Date },
): Promise<DayCapacitySummary | null> {
  const [day] = await tx
    .select()
    .from(doctorDayStates)
    .where(and(eq(doctorDayStates.doctorId, args.doctorId), eq(doctorDayStates.serviceDate, args.serviceDate)));
  const state = await loadDayCapacityState(tx, day, args);
  return state ? dayCapacitySummary(state, args.now) : null;
}

export async function getDayCapacity(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  now?: Date;
}): Promise<DayCapacitySummary | null> {
  const now = args.now ?? new Date();
  return withTenant(args.hospitalId, (tx) =>
    getDayCapacityInTx(tx, { ...args, serviceDate: serviceDateIn(args.timezone, now), now }),
  );
}

/**
 * Hands today's unused reserved walk-in capacity to the shared pool, so
 * online bookings can use it. Releases count only: no reserved token number is
 * ever given to anyone else. Idempotent — a second press changes nothing.
 */
export async function releaseReservedWalkIns(args: {
  hospitalId: string;
  doctorId: string;
  timezone: string;
  actorUserId?: string | null;
  now?: Date;
}): Promise<{ released: boolean }> {
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);
  return withTenant(args.hospitalId, async (tx) => {
    const day = await lockDoctorDay(tx, { ...args, serviceDate });
    const config = await loadDoctorCapacityConfig(tx, args.doctorId);
    if (!config || config.walkInReserved <= 0) return { released: false };
    if (day.reservedReleasedAt) return { released: true };

    await tx
      .update(doctorDayStates)
      .set({ reservedReleasedAt: now, updatedAt: now })
      .where(eq(doctorDayStates.id, day.id));
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'capacity.walk_in_reserve.released',
      objectType: 'doctor_day',
      objectId: day.id,
      metadata: {
        doctor_id: args.doctorId,
        service_date: serviceDate,
        walk_in_reserved: config.walkInReserved,
        reserved_issued: day.lastReservedToken,
      },
    });
    return { released: true };
  });
}

/**
 * Adds extra appointments to today's quota only. The doctor's standing quota
 * is untouched, so tomorrow runs on the configured number again.
 *
 * For example, if a doctor's quota is full (e.g. 50/50), an admin can add +10:
 * today's `extraCapacity` becomes 10 and the effective quota 60, immediately
 * allowing 10 more patients. A later change to the standing quota still
 * applies today, with the extra kept on top.
 */
export async function addDoctorDayCapacity(args: {
  hospitalId: string;
  doctorId: string;
  count: number;
  timezone: string;
  actorUserId?: string | null;
  now?: Date;
}): Promise<{ ok: true; previousQuota: number; newQuota: number } | { ok: false; error: string }> {
  if (!Number.isInteger(args.count) || args.count <= 0) {
    return { ok: false, error: 'Extra appointments count must be a positive integer.' };
  }
  const now = args.now ?? new Date();
  const serviceDate = serviceDateIn(args.timezone, now);

  return withTenant(args.hospitalId, async (tx) => {
    const day = await lockDoctorDay(tx, { ...args, serviceDate });
    const config = await loadDoctorCapacityConfig(tx, args.doctorId);
    if (!config) return { ok: false, error: 'Doctor not found.' };
    if (!config.quota) return { ok: false, error: 'Doctor does not have a daily quota configured.' };

    const previousQuota = config.quota + day.extraCapacity;
    const extraCapacity = day.extraCapacity + args.count;
    await tx
      .update(doctorDayStates)
      .set({ extraCapacity, updatedAt: now })
      .where(eq(doctorDayStates.id, day.id));

    const newQuota = config.quota + extraCapacity;
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'capacity.extra_quota.added',
      objectType: 'doctor_day',
      objectId: day.id,
      metadata: {
        doctor_id: args.doctorId,
        service_date: serviceDate,
        previous_quota: previousQuota,
        added_count: args.count,
        new_quota: newQuota,
      },
    });

    return { ok: true, previousQuota, newQuota };
  });
}

export type SaveCapacityResult =
  | { ok: true; abovePlan: boolean; planDailyCapacity: number | null }
  | { ok: false; errors: string[] };

/**
 * Saves a doctor's standing quota settings. They apply at once, today
 * included, and to every later day until changed again — there is no per-day
 * copy to go stale.
 *
 * The plan's daily capacity is advisory while hospitals are on trial: a quota
 * above it is saved and flagged, not refused.
 */
export async function saveDoctorCapacity(args: {
  hospitalId: string;
  doctorId: string;
  config: CapacityConfig;
  actorUserId?: string | null;
}): Promise<SaveCapacityResult> {
  const errors = validateCapacityConfig(args.config);
  if (errors.length > 0) return { ok: false, errors };

  return withTenant(args.hospitalId, async (tx) => {
    const [subscription] = await tx
      .select({ capacity: subscriptions.dailyAppointmentCapacity })
      .from(subscriptions)
      .where(and(eq(subscriptions.hospitalId, args.hospitalId), sql`${subscriptions.supersededAt} is null`))
      .limit(1);
    const planDailyCapacity = subscription?.capacity ?? null;

    const violation = planCapacityViolation(args.config.dailyQuota, planDailyCapacity);
    if (violation) return { ok: false as const, errors: [violation] };

    const [before] = await tx
      .select({
        dailyTokenQuota: doctors.dailyTokenQuota,
        walkInReserved: doctors.walkInReserved,
        onlineOpensMinutesBefore: doctors.onlineOpensMinutesBefore,
        walkInReleaseMinutes: doctors.walkInReleaseMinutes,
      })
      .from(doctors)
      .where(eq(doctors.id, args.doctorId));
    if (!before) return { ok: false as const, errors: ['Doctor not found.'] };

    await tx
      .update(doctors)
      .set({
        dailyTokenQuota: args.config.dailyQuota,
        walkInReserved: args.config.walkInReserved,
        onlineOpensMinutesBefore: args.config.onlineOpensMinutesBefore,
        walkInReleaseMinutes: args.config.walkInReleaseMinutes,
      })
      .where(eq(doctors.id, args.doctorId));

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId ?? null,
      action: 'doctor.capacity.updated',
      objectType: 'doctor',
      objectId: args.doctorId,
      metadata: { before, after: args.config, plan_daily_capacity: planDailyCapacity },
    });

    return {
      ok: true as const,
      abovePlan: exceedsPlanCapacity(args.config.dailyQuota, planDailyCapacity),
      planDailyCapacity,
    };
  });
}
