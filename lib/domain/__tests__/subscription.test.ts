import { describe, expect, it } from 'vitest';
import {
  addMonthsClamped,
  billingPeriod,
  daysUntilExpiry,
  expiryBucket,
  isServing,
  setupFeePaise,
  subscriptionEnd,
  subscriptionPricePaise,
  usageAxis,
  usageLevel,
  usagePercent,
  USAGE_CRITICAL_PERCENT,
  USAGE_WARNING_PERCENT,
} from '../subscription';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('addMonthsClamped', () => {
  it('adds ordinary months', () => {
    expect(addMonthsClamped(utc('2026-09-15'), 1).toISOString()).toContain('2026-10-15');
  });

  /**
   * A subscription starting on the 31st has no 31 February to renew into.
   * Plain date arithmetic rolls that into March and every later period drifts.
   */
  it('clamps to the last day when the target month is shorter', () => {
    expect(addMonthsClamped(utc('2026-01-31'), 1).toISOString()).toContain('2026-02-28');
    expect(addMonthsClamped(utc('2026-03-31'), 1).toISOString()).toContain('2026-04-30');
  });

  it('does not let a clamped month poison later periods', () => {
    // From 31 January: February clamps, but March must return to the 31st.
    const start = utc('2026-01-31');
    expect(addMonthsClamped(start, 1).toISOString()).toContain('2026-02-28');
    expect(addMonthsClamped(start, 2).toISOString()).toContain('2026-03-31');
    expect(addMonthsClamped(start, 3).toISOString()).toContain('2026-04-30');
  });

  it('crosses year boundaries', () => {
    expect(addMonthsClamped(utc('2026-11-15'), 3).toISOString()).toContain('2027-02-15');
  });
});

describe('billingPeriod', () => {
  const startsAt = utc('2026-09-15');

  it('returns the first period on the start date itself', () => {
    const period = billingPeriod({ startsAt, now: startsAt });
    expect(period.ordinal).toBe(0);
    expect(period.start).toEqual(startsAt);
    expect(period.end.toISOString()).toContain('2026-10-15');
  });

  it('anchors on the subscription date, not the calendar month', () => {
    // 1 October is inside the 15 Sept – 15 Oct window, not a new period.
    const period = billingPeriod({ startsAt, now: utc('2026-10-01') });
    expect(period.ordinal).toBe(0);
    expect(period.start).toEqual(startsAt);
  });

  it('rolls over on the anniversary day', () => {
    const period = billingPeriod({ startsAt, now: utc('2026-10-15') });
    expect(period.ordinal).toBe(1);
    expect(period.start.toISOString()).toContain('2026-10-15');
    expect(period.end.toISOString()).toContain('2026-11-15');
  });

  it('is correct many periods later', () => {
    const period = billingPeriod({ startsAt, now: utc('2027-06-20') });
    expect(period.ordinal).toBe(9);
    expect(period.start.toISOString()).toContain('2027-06-15');
  });

  /**
   * From a 31 January anchor the windows are 31 Jan–28 Feb, 28 Feb–31 Mar,
   * 31 Mar–30 Apr. February's period is short because February is short, but
   * the anchor returns to the 31st afterwards rather than drifting forward a
   * few days every month, which is what naive date addition would do.
   */
  it('handles a month-end anchor without drifting', () => {
    const endOfMonth = utc('2026-01-31');
    const ordinalAt = (day: string) =>
      billingPeriod({ startsAt: endOfMonth, now: utc(day) }).ordinal;

    expect(ordinalAt('2026-02-15')).toBe(0); // still inside 31 Jan – 28 Feb
    expect(ordinalAt('2026-02-28')).toBe(1); // rolls over on the clamped date
    expect(ordinalAt('2026-03-30')).toBe(1);
    expect(ordinalAt('2026-03-31')).toBe(2); // back on the 31st, not the 28th
  });

  it('never returns a period that excludes the moment asked about', () => {
    // The property that matters: usage must always land in exactly one window.
    const anchors = ['2026-01-31', '2026-02-28', '2026-09-15', '2026-12-01'];
    for (const anchor of anchors) {
      const from = utc(anchor);
      for (let day = 0; day < 400; day += 7) {
        const now = new Date(from.getTime() + day * 24 * 60 * 60 * 1000);
        const period = billingPeriod({ startsAt: from, now });
        expect(period.start.getTime()).toBeLessThanOrEqual(now.getTime());
        expect(period.end.getTime()).toBeGreaterThan(now.getTime());
      }
    }
  });

  it('reports the first period for a subscription that has not started', () => {
    const period = billingPeriod({ startsAt, now: utc('2026-09-01') });
    expect(period.ordinal).toBe(0);
  });
});

describe('term and price', () => {
  it('ends one month later on monthly, twelve on annual', () => {
    const startsAt = utc('2026-09-15');
    expect(subscriptionEnd({ startsAt, cycle: 'monthly' }).toISOString()).toContain('2026-10-15');
    expect(subscriptionEnd({ startsAt, cycle: 'annual' }).toISOString()).toContain('2027-09-15');
  });

  it('waives the setup fee on annual prepay only', () => {
    expect(setupFeePaise({ cycle: 'monthly', tierSetupFeePaise: 500_000 })).toBe(500_000);
    expect(setupFeePaise({ cycle: 'annual', tierSetupFeePaise: 500_000 })).toBe(0);
  });

  it('takes the waiver from the tier rather than a hardcoded figure', () => {
    // A tier with a larger install cost keeps it on monthly.
    expect(setupFeePaise({ cycle: 'monthly', tierSetupFeePaise: 900_000 })).toBe(900_000);
  });

  it('charges the matching price for the cycle', () => {
    const prices = { monthlyPricePaise: 699_900, annualPricePaise: 6_999_000 };
    expect(subscriptionPricePaise({ cycle: 'monthly', ...prices })).toBe(699_900);
    expect(subscriptionPricePaise({ cycle: 'annual', ...prices })).toBe(6_999_000);
  });
});

describe('usage', () => {
  it('computes percentage against the allowance', () => {
    expect(usagePercent(3_840, 5_300)).toBeCloseTo(72.45, 1);
  });

  it('is unknown rather than zero when there is no allowance', () => {
    // A hospital with no plan has not used 0% — the question does not apply.
    expect(usagePercent(100, 0)).toBeNull();
    expect(usageLevel(null)).toBe('normal');
  });

  it('classifies against the warning thresholds', () => {
    expect(usageLevel(49)).toBe('normal');
    expect(usageLevel(USAGE_WARNING_PERCENT)).toBe('warning');
    expect(usageLevel(USAGE_CRITICAL_PERCENT)).toBe('critical');
    expect(usageLevel(100)).toBe('exhausted');
    expect(usageLevel(140)).toBe('exhausted');
  });

  it('never reports negative remaining for a hospital past its quota', () => {
    const axis = usageAxis(6_000, 5_300);
    expect(axis.remaining).toBe(0);
    expect(axis.level).toBe('exhausted');
  });

  it('reports remaining correctly inside the quota', () => {
    const axis = usageAxis(3_840, 5_300);
    expect(axis.remaining).toBe(1_460);
    expect(axis.level).toBe('normal');
  });
});

describe('expiry', () => {
  const now = new Date('2026-09-15T10:00:00.000Z');
  const inDays = (n: number) => new Date(now.getTime() + n * 24 * 60 * 60 * 1000);

  it('buckets by urgency', () => {
    expect(expiryBucket(inDays(-1), now)).toBe('expired');
    expect(expiryBucket(inDays(0.5), now)).toBe('tomorrow');
    expect(expiryBucket(inDays(2), now)).toBe('within_3_days');
    expect(expiryBucket(inDays(5), now)).toBe('within_7_days');
    expect(expiryBucket(inDays(20), now)).toBe('within_30_days');
  });

  it('is null when expiry is comfortably far off', () => {
    expect(expiryBucket(inDays(90), now)).toBeNull();
    expect(expiryBucket(null, now)).toBeNull();
  });

  it('counts days remaining', () => {
    expect(daysUntilExpiry(inDays(7), now)).toBe(7);
    expect(daysUntilExpiry(null, now)).toBeNull();
  });
});

describe('status', () => {
  it('serves traffic on active and trial only', () => {
    expect(isServing('active')).toBe(true);
    expect(isServing('trial')).toBe(true);
    for (const status of ['expired', 'cancelled', 'suspended'] as const) {
      expect(isServing(status)).toBe(false);
    }
  });
});
