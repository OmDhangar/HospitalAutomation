import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
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
import { formatTimeIn, serviceDateIn } from '@/lib/domain/time';
import { lockDoctorDay, type DoctorDayState } from './doctor-day';
import { resolveScheduledStartInTx } from './scheduling';

/** Statuses that no longer count against the day's quota. */
const RELEASED_STATUSES = ['CANCELLED', 'EXPIRED', 'NO_SHOW'] as const;

export type CapacityErrorCode = 'ONLINE_NOT_OPEN' | 'QUOTA_REACHED' | 'FULLY_BOOKED' | 'EXTRA_NOT_NEEDED';

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
 * Copies the doctor's quota onto the day the first time a token is issued.
 *
 * After that the day keeps its numbers: an owner editing the quota at noon
 * changes tomorrow, not the line already standing in the corridor. A day that
 * issued tokens before a quota existed stays quota-free.
 */
async function snapshotIfFirstToken(tx: Tx, day: DoctorDayState, doctorId: string): Promise<DoctorDayState> {
  if (day.tokenQuota !== null || day.lastTokenNumber > 0 || day.lastReservedToken > 0) return day;

  const [doctor] = await tx
    .select({
      quota: doctors.dailyTokenQuota,
      walkInReserved: doctors.walkInReserved,
      opens: doctors.onlineOpensMinutesBefore,
      release: doctors.walkInReleaseMinutes,
    })
    .from(doctors)
    .where(eq(doctors.id, doctorId));
  if (!doctor?.quota) return day;

  const walkInReserved = Math.min(doctor.walkInReserved, doctor.quota);
  const [updated] = await tx
    .update(doctorDayStates)
    .set({
      tokenQuota: doctor.quota,
      walkInReserved,
      onlineOpensMinutesBefore: doctor.opens,
      walkInReleaseMinutes: doctor.release,
      // Shared tokens are numbered after the reserved range.
      lastTokenNumber: walkInReserved,
    })
    .where(eq(doctorDayStates.id, day.id))
    .returning();
  return updated;
}

/** Active appointments per pool for one doctor-day. Must run after the lock. */
async function countActiveByPool(tx: Tx, doctorId: string, serviceDate: string) {
  const rows = await tx
    .select({ pool: appointments.quotaPool, n: sql<number>`count(*)::int` })
    .from(appointments)
    .where(
      and(
        eq(appointments.doctorId, doctorId),
        eq(appointments.serviceDate, serviceDate),
        notInArray(appointments.status, [...RELEASED_STATUSES]),
        inArray(appointments.quotaPool, ['reserved', 'shared', 'extra']),
      ),
    )
    .groupBy(appointments.quotaPool);
  const get = (pool: QuotaPool) => rows.find((r) => r.pool === pool)?.n ?? 0;
  return { reservedActive: get('reserved'), sharedActive: get('shared'), extraActive: get('extra') };
}

async function loadDayCapacityState(
  tx: Tx,
  day: DoctorDayState,
  args: { doctorId: string; serviceDate: string; timezone: string },
): Promise<DayCapacityState | null> {
  if (day.tokenQuota === null) return null;
  const [counts, scheduledStartAt] = await Promise.all([
    countActiveByPool(tx, args.doctorId, args.serviceDate),
    resolveScheduledStartInTx(tx, { ...args, dayOverride: day.scheduledStartAt }),
  ]);
  return {
    quota: day.tokenQuota,
    walkInReserved: day.walkInReserved ?? 0,
    onlineOpensMinutesBefore: day.onlineOpensMinutesBefore ?? 120,
    walkInReleaseMinutes: day.walkInReleaseMinutes,
    reservedReleasedAt: day.reservedReleasedAt,
    sessionStartedAt: day.sessionStartedAt,
    scheduledStartAt,
    lastReservedToken: day.lastReservedToken,
    lastToken: day.lastTokenNumber,
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
  let day = await lockDoctorDay(tx, args);
  day = await snapshotIfFirstToken(tx, day, args.doctorId);

  const state = await loadDayCapacityState(tx, day, args);
  if (!state) {
    const tokenNumber = day.lastTokenNumber + 1;
    await tx
      .update(doctorDayStates)
      .set({ lastTokenNumber: tokenNumber, updatedAt: args.now })
      .where(eq(doctorDayStates.id, day.id));
    return { tokenNumber, pool: null };
  }

  const isSameDay = args.serviceDate === serviceDateIn(args.timezone, args.now);
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

/** Today's capacity picture for one doctor, or null when the doctor has no quota. */
export async function getDayCapacityInTx(
  tx: Tx,
  args: { doctorId: string; serviceDate: string; timezone: string; now: Date },
): Promise<DayCapacitySummary | null> {
  const [day] = await tx
    .select()
    .from(doctorDayStates)
    .where(and(eq(doctorDayStates.doctorId, args.doctorId), eq(doctorDayStates.serviceDate, args.serviceDate)));

  let state: DayCapacityState | null = null;
  if (day && day.tokenQuota !== null) {
    state = await loadDayCapacityState(tx, day, args);
  } else if (!day || (day.lastTokenNumber === 0 && day.lastReservedToken === 0)) {
    // No token yet today: show what the day will start with.
    const [doctor] = await tx
      .select({
        quota: doctors.dailyTokenQuota,
        walkInReserved: doctors.walkInReserved,
        opens: doctors.onlineOpensMinutesBefore,
        release: doctors.walkInReleaseMinutes,
      })
      .from(doctors)
      .where(eq(doctors.id, args.doctorId));
    if (!doctor?.quota) return null;
    const walkInReserved = Math.min(doctor.walkInReserved, doctor.quota);
    state = {
      quota: doctor.quota,
      walkInReserved,
      onlineOpensMinutesBefore: doctor.opens,
      walkInReleaseMinutes: doctor.release,
      reservedReleasedAt: day?.reservedReleasedAt ?? null,
      sessionStartedAt: day?.sessionStartedAt ?? null,
      scheduledStartAt: await resolveScheduledStartInTx(tx, { ...args, dayOverride: day?.scheduledStartAt }),
      lastReservedToken: 0,
      lastToken: walkInReserved,
      reservedActive: 0,
      sharedActive: 0,
      extraActive: 0,
    };
  }
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
    let day = await lockDoctorDay(tx, { ...args, serviceDate });
    day = await snapshotIfFirstToken(tx, day, args.doctorId);
    if (day.tokenQuota === null) return { released: false };
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
        walk_in_reserved: day.walkInReserved,
        reserved_issued: day.lastReservedToken,
      },
    });
    return { released: true };
  });
}

export type SaveCapacityResult =
  | { ok: true; abovePlan: boolean; planDailyCapacity: number | null }
  | { ok: false; errors: string[] };

/**
 * Saves a doctor's standing quota settings. Applies from the next day that has
 * not issued a token yet; a day in progress keeps its snapshot.
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
