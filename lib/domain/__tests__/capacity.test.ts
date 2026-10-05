import { describe, expect, it } from 'vitest';
import {
  dayCapacitySummary,
  decideAllocation,
  exceedsPlanCapacity,
  isReleased,
  planCapacityViolation,
  validateCapacityConfig,
  type CapacityChannel,
  type DayCapacityState,
  type QuotaPool,
} from '../capacity';
import { zonedTimeToUtc } from '../time';

const start = new Date(Date.UTC(2026, 9, 5, 8, 30)); // 2:00 pm IST
const at = (m: number) => new Date(start.getTime() + m * 60_000);

const day = (over: Partial<DayCapacityState> = {}): DayCapacityState => ({
  quota: 100,
  walkInReserved: 30,
  onlineOpensMinutesBefore: 120,
  walkInReleaseMinutes: null,
  reservedReleasedAt: null,
  scheduledStartAt: start,
  sessionStartedAt: null,
  lastReservedToken: 0,
  lastToken: 30,
  reservedActive: 0,
  sharedActive: 0,
  extraActive: 0,
  ...over,
});

/** Applies a decision to the state, the way the service does under the lock. */
function issue(state: DayCapacityState, channel: CapacityChannel, now: Date) {
  const d = decideAllocation(state, channel, now);
  if (!d.ok) return { state, decision: d };
  const pool: QuotaPool = d.pool;
  return {
    decision: d,
    state: {
      ...state,
      lastReservedToken: pool === 'reserved' ? d.tokenNumber : state.lastReservedToken,
      lastToken: pool === 'reserved' ? state.lastToken : d.tokenNumber,
      reservedActive: state.reservedActive + (pool === 'reserved' ? 1 : 0),
      sharedActive: state.sharedActive + (pool === 'shared' ? 1 : 0),
      extraActive: state.extraActive + (pool === 'extra' ? 1 : 0),
    },
  };
}

describe('reserved walk-in pool and shared pool', () => {
  it('early walk-ins take 1..W, later walk-ins continue in the shared pool', () => {
    let s = day({ quota: 10, walkInReserved: 3, lastToken: 3 });
    const tokens: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = issue(s, 'walk_in', at(-180));
      if (r.decision.ok) tokens.push(r.decision.tokenNumber);
      s = r.state;
    }
    expect(tokens).toEqual([1, 2, 3, 4, 5]);
    expect(s.reservedActive).toBe(3);
    expect(s.sharedActive).toBe(2);
  });

  it('online and walk-ins share one sequence above W', () => {
    let s = day({ quota: 10, walkInReserved: 3, lastToken: 3, lastReservedToken: 3, reservedActive: 3 });
    const seen: Array<[string, number]> = [];
    for (const ch of ['online', 'walk_in', 'online'] as const) {
      const r = issue(s, ch, at(-60));
      if (r.decision.ok) seen.push([ch, r.decision.tokenNumber]);
      s = r.state;
    }
    expect(seen).toEqual([['online', 4], ['walk_in', 5], ['online', 6]]);
  });

  it('online queue booking waits for the opening window; slots do not', () => {
    const d = decideAllocation(day(), 'online', at(-121));
    expect(d).toEqual({ ok: false, reason: 'online_not_open', opensAt: at(-120) });
    expect(decideAllocation(day(), 'online', at(-120)).ok).toBe(true);
    expect(decideAllocation(day(), 'online_slot', at(-24 * 60)).ok).toBe(true);
  });

  it('online is open at any time when no start time is configured', () => {
    expect(decideAllocation(day({ scheduledStartAt: null }), 'online', at(-9999)).ok).toBe(true);
  });

  it('online cannot take reserved capacity before release', () => {
    const s = day({ quota: 10, walkInReserved: 3, sharedActive: 7, lastToken: 10 });
    expect(decideAllocation(s, 'online', at(0))).toEqual({ ok: false, reason: 'fully_booked', reservedUnused: 3 });
    expect(dayCapacitySummary(s, at(0)).onlineBlockedByReserve).toBe(true);
  });

  it('release raises the shared count without handing out reserved numbers', () => {
    const s = day({ quota: 10, walkInReserved: 3, lastReservedToken: 1, reservedActive: 1, sharedActive: 7, lastToken: 10 });
    const released = { ...s, reservedReleasedAt: at(0) };
    const d = decideAllocation(released, 'online', at(1));
    expect(d).toEqual({ ok: true, pool: 'shared', tokenNumber: 11 });
    // After release, walk-ins no longer draw reserved numbers either.
    expect(decideAllocation(released, 'walk_in', at(1))).toEqual({ ok: true, pool: 'shared', tokenNumber: 11 });
  });

  it('releases unused reserved capacity automatically at Start OPD', () => {
    // Not before OPD starts, however late it gets.
    expect(isReleased(day(), at(10_000))).toBe(false);
    // Blank minutes means at the moment OPD starts.
    const started = day({ sessionStartedAt: at(20) });
    expect(isReleased(started, at(19))).toBe(false);
    expect(isReleased(started, at(20))).toBe(true);
    expect(isReleased(day({ sessionStartedAt: at(20), walkInReleaseMinutes: 0 }), at(20))).toBe(true);
  });

  it('can wait a configured number of minutes after Start OPD', () => {
    const s = day({ sessionStartedAt: at(20), walkInReleaseMinutes: 30 });
    expect(isReleased(s, at(49))).toBe(false);
    expect(isReleased(s, at(50))).toBe(true);
  });

  it('the scheduled start alone does not release; the manual release still does', () => {
    expect(isReleased(day({ walkInReleaseMinutes: 0 }), at(60))).toBe(false);
    expect(isReleased(day({ reservedReleasedAt: at(-30) }), at(-30))).toBe(true);
  });

  it('after Start OPD, online gets the next shared number, never a reserved one', () => {
    const s = day({ quota: 3, walkInReserved: 2, lastReservedToken: 1, reservedActive: 1, sharedActive: 1, lastToken: 3 });
    expect(decideAllocation(s, 'online', at(5)).ok).toBe(false);
    expect(decideAllocation({ ...s, sessionStartedAt: at(5) }, 'online', at(5))).toEqual({
      ok: true,
      pool: 'shared',
      tokenNumber: 4,
    });
  });

  it('a cancellation frees capacity but never its number', () => {
    // 3 reserved numbers used, one of them cancelled: count 2, but 1..3 are spent.
    const s = day({ quota: 5, walkInReserved: 3, lastReservedToken: 3, reservedActive: 2, sharedActive: 2, lastToken: 5 });
    expect(decideAllocation(s, 'walk_in', at(0))).toEqual({ ok: true, pool: 'shared', tokenNumber: 6 });
  });

  it('walk-ins can use unused reserved capacity even when the shared pool is full', () => {
    const s = day({ quota: 10, walkInReserved: 3, lastReservedToken: 3, reservedActive: 2, sharedActive: 7, lastToken: 10 });
    expect(decideAllocation(s, 'online', at(0)).ok).toBe(false);
    expect(decideAllocation(s, 'walk_in', at(0))).toEqual({ ok: true, pool: 'shared', tokenNumber: 11 });
  });

  it('W = 0 makes everything shared; W = Q keeps online closed until release', () => {
    const none = day({ quota: 5, walkInReserved: 0, lastToken: 0 });
    expect(decideAllocation(none, 'walk_in', at(0))).toEqual({ ok: true, pool: 'shared', tokenNumber: 1 });
    const all = day({ quota: 5, walkInReserved: 5, lastToken: 5 });
    expect(decideAllocation(all, 'online', at(0)).ok).toBe(false);
    expect(decideAllocation({ ...all, reservedReleasedAt: at(0) }, 'online', at(0)).ok).toBe(true);
  });
});

describe('quota and extra tokens', () => {
  it('stops normal booking at Q', () => {
    const full = day({ quota: 4, walkInReserved: 2, lastReservedToken: 2, reservedActive: 2, sharedActive: 2, lastToken: 4 });
    expect(decideAllocation(full, 'walk_in', at(0))).toEqual({ ok: false, reason: 'quota_reached' });
    expect(decideAllocation(full, 'online', at(0)).ok).toBe(false);
    expect(dayCapacitySummary(full, at(0)).quotaReached).toBe(true);
  });

  it('extra is refused while total active < Q, even with the shared pool full and reserve unused', () => {
    const s = day({ quota: 10, walkInReserved: 3, sharedActive: 7, lastToken: 10 });
    expect(decideAllocation(s, 'extra', at(0))).toEqual({ ok: false, reason: 'extra_not_needed' });
  });

  it('extra continues the sequence once the quota is reached and never exceeds through normal channels', () => {
    let s = day({ quota: 4, walkInReserved: 2, lastReservedToken: 2, reservedActive: 2, sharedActive: 2, lastToken: 4 });
    const first = issue(s, 'extra', at(0));
    expect(first.decision).toEqual({ ok: true, pool: 'extra', tokenNumber: 5 });
    s = first.state;
    expect(issue(s, 'extra', at(0)).decision).toEqual({ ok: true, pool: 'extra', tokenNumber: 6 });
    expect(decideAllocation(s, 'walk_in', at(0)).ok).toBe(false);
  });

  it('never lets total active exceed Q through normal channels, whatever the order', () => {
    const channels: CapacityChannel[] = ['walk_in', 'online', 'online_slot'];
    let seed = 3;
    for (let run = 0; run < 100; run += 1) {
      let s = day({ quota: 12, walkInReserved: 4, lastToken: 4, walkInReleaseMinutes: run % 2 ? 20 : null, sessionStartedAt: run % 3 ? at(-10) : null });
      const seen = new Set<number>();
      for (let i = 0; i < 40; i += 1) {
        seed = (seed * 48271) % 2147483647;
        const r = issue(s, channels[seed % 3], at(-60 + i * 3));
        if (r.decision.ok) {
          expect(seen.has(r.decision.tokenNumber)).toBe(false);
          seen.add(r.decision.tokenNumber);
        }
        s = r.state;
        expect(s.reservedActive + s.sharedActive).toBeLessThanOrEqual(12);
      }
    }
  });
});

describe('configuration', () => {
  it('rejects W > Q and accepts W = 0 or W = Q', () => {
    const base = { onlineOpensMinutesBefore: 120, walkInReleaseMinutes: null };
    expect(validateCapacityConfig({ ...base, dailyQuota: 50, walkInReserved: 60 })).toHaveLength(1);
    expect(validateCapacityConfig({ ...base, dailyQuota: 50, walkInReserved: 0 })).toEqual([]);
    expect(validateCapacityConfig({ ...base, dailyQuota: 50, walkInReserved: 50 })).toEqual([]);
    expect(validateCapacityConfig({ ...base, dailyQuota: null, walkInReserved: 0 })).toEqual([]);
    expect(validateCapacityConfig({ ...base, dailyQuota: 0, walkInReserved: 0 })).toHaveLength(1);
  });

  it('allows a quota above the plan while trial mode is on', () => {
    expect(exceedsPlanCapacity(150, 100)).toBe(true);
    expect(planCapacityViolation(150, 100)).toBeNull();
  });
});

describe('zonedTimeToUtc', () => {
  it('converts a wall-clock time in the hospital timezone', () => {
    expect(zonedTimeToUtc('2026-10-05', '14:00', 'Asia/Kolkata').toISOString()).toBe('2026-10-05T08:30:00.000Z');
    expect(zonedTimeToUtc('2026-10-05', '09:00:00', 'UTC').toISOString()).toBe('2026-10-05T09:00:00.000Z');
    expect(zonedTimeToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe('2026-07-01T13:00:00.000Z');
  });
});
