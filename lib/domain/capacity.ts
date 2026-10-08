/**
 * Daily token capacity for one doctor: a workload target the hospital sets,
 * not a subscription limit.
 *
 *   Daily quota Q
 *     ├── Reserved walk-in pool (W): tokens 1..W, for patients who physically
 *     │     reach the hospital early, so they do not lose their place to people
 *     │     who booked from home hours before.
 *     └── Shared pool (Q − W): tokens W+1 onward, used by online/WhatsApp
 *           bookings and by any further walk-ins.
 *   After Q: EXTRA tokens, issued one by one by the owner, continuing the same
 *   sequence.
 *
 * Every rule about who may take a token lives in `decideAllocation`. It is
 * pure: the service locks the doctor-day row, reads the counts, asks this
 * function, and writes what it says.
 *
 * The configuration is the doctor's standing one, read live on every
 * allocation — never a per-day copy. An owner who raises the reserve at 9am
 * changes today, not just tomorrow. That makes a mid-day change routine, so
 * the numbering below is written to stay collision-free when W moves under a
 * day that has already issued tokens.
 *
 * Token numbers are never reused or renumbered. Unused reserved capacity can be
 * released into the shared pool, but that releases *count*, not numbers — a
 * remote booker is never handed a low reserved number like 25 that would put
 * them ahead of people who are physically present. Those numbers stay unused.
 */

export type QuotaPool = 'reserved' | 'shared' | 'extra';

/**
 * - `walk_in`: a patient at the desk.
 * - `online`: joining today's live queue from WhatsApp or the web.
 * - `online_slot`: a booked time slot, possibly days ahead.
 * - `extra`: the owner deliberately issuing a token past the quota.
 */
export type CapacityChannel = 'walk_in' | 'online' | 'online_slot' | 'extra';

/**
 * Plan-based limits are not enforced while hospitals are on trial. The check
 * exists so turning it on later is a one-line change, not a redesign.
 */
export const PLAN_CAPACITY_ENFORCED = false;

export const DEFAULT_ONLINE_OPENS_MINUTES_BEFORE = 120;
const MAX_QUOTA = 1000;
const MAX_WINDOW_MINUTES = 12 * 60;

/** A doctor's standing configuration (doctors table). */
export type CapacityConfig = {
  /** Null means no quota: the doctor works exactly as before this feature. */
  dailyQuota: number | null;
  walkInReserved: number;
  onlineOpensMinutesBefore: number;
  /**
   * Minutes after Start OPD at which unused reserved walk-in capacity joins the
   * shared pool. Null means 0: released the moment OPD starts.
   */
  walkInReleaseMinutes: number | null;
};

/** The doctor's live config for one day, plus what that day has issued so far. */
export type DayCapacityState = {
  /** Standing quota plus today's extra capacity. Null: no limit, only the reserve applies. */
  quota: number | null;
  walkInReserved: number;
  onlineOpensMinutesBefore: number;
  walkInReleaseMinutes: number | null;
  reservedReleasedAt: Date | null;
  scheduledStartAt: Date | null;
  /** Set only by Start OPD. Unused reserved capacity is released from here. */
  sessionStartedAt: Date | null;
  /** Highest reserved token issued (1..W). */
  lastReservedToken: number;
  /** Highest shared/extra token issued. */
  lastToken: number;
  /**
   * Token numbers already issued inside (lastReservedToken, W]. Only non-empty
   * when the reserve was raised after shared tokens were handed out; walk-ins
   * then skip those numbers instead of colliding with them.
   */
  reservedRangeTaken?: readonly number[];
  /** Appointments that still count against the quota (not cancelled/expired/no-show). */
  reservedActive: number;
  sharedActive: number;
  extraActive: number;
};

export type AllocationDecision =
  | { ok: true; pool: QuotaPool; tokenNumber: number }
  | { ok: false; reason: 'online_not_open'; opensAt: Date }
  | { ok: false; reason: 'quota_reached' }
  | { ok: false; reason: 'fully_booked'; reservedUnused: number }
  | { ok: false; reason: 'extra_not_needed' };

export function validateCapacityConfig(config: CapacityConfig): string[] {
  const errors: string[] = [];
  const isInt = (n: number) => Number.isInteger(n);
  if (config.dailyQuota !== null) {
    if (!isInt(config.dailyQuota) || config.dailyQuota < 1 || config.dailyQuota > MAX_QUOTA) {
      errors.push(`Daily quota must be a whole number between 1 and ${MAX_QUOTA}.`);
    }
  }
  if (!isInt(config.walkInReserved) || config.walkInReserved < 0) {
    errors.push('Reserved walk-in tokens must be zero or more.');
  } else if (config.walkInReserved > MAX_QUOTA) {
    errors.push(`Reserved walk-in tokens cannot be more than ${MAX_QUOTA}.`);
  } else if (config.dailyQuota !== null && config.walkInReserved > config.dailyQuota) {
    errors.push('Reserved walk-in tokens cannot be more than the daily quota.');
  }
  if (
    !isInt(config.onlineOpensMinutesBefore) ||
    config.onlineOpensMinutesBefore < 0 ||
    config.onlineOpensMinutesBefore > MAX_WINDOW_MINUTES
  ) {
    errors.push('Online booking must open between 0 and 720 minutes before the start.');
  }
  if (
    config.walkInReleaseMinutes !== null &&
    (!isInt(config.walkInReleaseMinutes) ||
      config.walkInReleaseMinutes < 0 ||
      config.walkInReleaseMinutes > MAX_WINDOW_MINUTES)
  ) {
    errors.push('Release time must be between 0 and 720 minutes after Start OPD.');
  }
  return errors;
}

/** Whether a quota is above what the plan is sold for. Advisory only while trials run. */
export const exceedsPlanCapacity = (quota: number | null, planDailyCapacity: number | null): boolean =>
  quota !== null && planDailyCapacity !== null && planDailyCapacity > 0 && quota > planDailyCapacity;

/** The blocking form of the plan check; returns null while enforcement is off. */
export function planCapacityViolation(quota: number | null, planDailyCapacity: number | null): string | null {
  if (!PLAN_CAPACITY_ENFORCED || !exceedsPlanCapacity(quota, planDailyCapacity)) return null;
  return `The daily quota cannot exceed your plan's ${planDailyCapacity} patients per day.`;
}

/** When same-day online queue booking opens; null when no start time is known (always open). */
export function onlineOpensAt(day: Pick<DayCapacityState, 'scheduledStartAt' | 'onlineOpensMinutesBefore'>): Date | null {
  if (!day.scheduledStartAt) return null;
  return new Date(day.scheduledStartAt.getTime() - day.onlineOpensMinutesBefore * 60_000);
}

/**
 * Whether unused reserved walk-in capacity has been handed to the shared pool.
 *
 * Automatic once OPD actually starts (Start OPD, plus the configured minutes,
 * 0 by default): the reservation protects patients who arrive before the
 * doctor, and once the doctor is seeing patients, places nobody walked in for
 * are better used by online bookings. Keyed to the real start, not the
 * scheduled one — a late doctor keeps the reservation until they arrive. The
 * owner can also release by hand at any time.
 */
export function isReleased(
  day: Pick<DayCapacityState, 'reservedReleasedAt' | 'walkInReleaseMinutes' | 'sessionStartedAt'>,
  now: Date,
): boolean {
  if (day.reservedReleasedAt) return true;
  if (!day.sessionStartedAt) return false;
  return now.getTime() >= day.sessionStartedAt.getTime() + (day.walkInReleaseMinutes ?? 0) * 60_000;
}

const totalActive = (day: DayCapacityState) => day.reservedActive + day.sharedActive + day.extraActive;

const underQuota = (day: DayCapacityState, total: number) => day.quota === null || total < day.quota;

/**
 * How many shared tokens online bookings may hold. Until release, reserved
 * capacity is fenced off whether used or not; after it, only what walk-ins
 * actually hold is. Unlimited without a quota.
 */
const onlineSharedCap = (day: DayCapacityState, now: Date) => {
  if (day.quota === null) return Infinity;
  return isReleased(day, now) ? day.quota - day.reservedActive : day.quota - day.walkInReserved;
};

/**
 * Shared numbers always sit above the reserved range as it stands now, and
 * above any reserved number already issued — a reserve lowered from 20 to 5
 * after walk-ins took 1..8 must not hand out 6 again.
 */
const nextShared = (day: DayCapacityState) =>
  Math.max(day.lastToken, day.walkInReserved, day.lastReservedToken) + 1;

/** The next free reserved number, or null when the reserved range is used up. */
function nextReserved(day: DayCapacityState): number | null {
  const taken = new Set(day.reservedRangeTaken ?? []);
  for (let n = day.lastReservedToken + 1; n <= day.walkInReserved; n += 1) {
    if (!taken.has(n)) return n;
  }
  return null;
}

/**
 * Who gets which token, or why not. Invariant on every path: appointments
 * counting against the quota never exceed Q, except through `extra`.
 */
export function decideAllocation(
  day: DayCapacityState,
  channel: CapacityChannel,
  now: Date,
  options?: { isSameDay?: boolean },
): AllocationDecision {
  const total = totalActive(day);

  switch (channel) {
    case 'walk_in': {
      const reserved = isReleased(day, now) ? null : nextReserved(day);
      if (reserved !== null && underQuota(day, total)) {
        return { ok: true, pool: 'reserved', tokenNumber: reserved };
      }
      // Walk-ins may use any capacity left under Q, including reserved capacity
      // a cancellation freed — the reservation exists for them.
      if (underQuota(day, total)) return { ok: true, pool: 'shared', tokenNumber: nextShared(day) };
      return { ok: false, reason: 'quota_reached' };
    }
    case 'online':
    case 'online_slot': {
      const isSameDay = options?.isSameDay ?? true;
      if (isSameDay) {
        const opens = onlineOpensAt(day);
        if (opens && now.getTime() < opens.getTime()) {
          return { ok: false, reason: 'online_not_open', opensAt: opens };
        }
      }
      if (day.sharedActive < onlineSharedCap(day, now) && underQuota(day, total)) {
        return { ok: true, pool: 'shared', tokenNumber: nextShared(day) };
      }
      return { ok: false, reason: 'fully_booked', reservedUnused: reservedUnused(day, now) };
    }
    case 'extra': {
      // Extra is for when the day is genuinely full — not for when online is
      // full while walk-in capacity sits unused (release that first).
      if (underQuota(day, total)) return { ok: false, reason: 'extra_not_needed' };
      return { ok: true, pool: 'extra', tokenNumber: nextShared(day) };
    }
  }
}

/** Reserved capacity that is fenced off from online bookings but not used by walk-ins. */
export function reservedUnused(day: DayCapacityState, now: Date): number {
  if (isReleased(day, now)) return 0;
  return Math.max(0, day.walkInReserved - day.reservedActive);
}

export type DayCapacitySummary = {
  /** Null: no daily limit, only the walk-in reserve applies. */
  quota: number | null;
  walkInReserved: number;
  reservedActive: number;
  sharedActive: number;
  /** How many shared tokens online can hold right now. */
  sharedCap: number;
  extraActive: number;
  totalActive: number;
  released: boolean;
  reservedUnused: number;
  onlineOpensAt: Date | null;
  /** Online is full only because reserved capacity has not been released. */
  onlineBlockedByReserve: boolean;
  quotaReached: boolean;
};

export function dayCapacitySummary(day: DayCapacityState, now: Date): DayCapacitySummary {
  const total = totalActive(day);
  const cap = onlineSharedCap(day, now);
  const unused = reservedUnused(day, now);
  return {
    quota: day.quota,
    walkInReserved: day.walkInReserved,
    reservedActive: day.reservedActive,
    sharedActive: day.sharedActive,
    sharedCap: cap,
    extraActive: day.extraActive,
    totalActive: total,
    released: isReleased(day, now),
    reservedUnused: unused,
    onlineOpensAt: onlineOpensAt(day),
    onlineBlockedByReserve: day.sharedActive >= cap && underQuota(day, total) && unused > 0,
    quotaReached: !underQuota(day, total),
  };
}
