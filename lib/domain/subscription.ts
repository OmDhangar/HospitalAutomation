export const BILLING_CYCLES = ['monthly', 'annual'] as const;
export type BillingCycle = (typeof BILLING_CYCLES)[number];

export const SUBSCRIPTION_STATUSES = [
  'trial',
  'active',
  'expired',
  'cancelled',
  'suspended',
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/** A subscription is live if it should be serving traffic right now. */
export const isServing = (status: SubscriptionStatus): boolean =>
  status === 'active' || status === 'trial';

/**
 * Adds months while surviving month-end.
 *
 * A subscription starting on 31 January has no 31 February to renew into.
 * JavaScript would roll that forward to 2 or 3 March and every subsequent
 * period would drift. Clamping to the last day of the target month keeps the
 * anchor stable for the life of the subscription.
 */
export function addMonthsClamped(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();

  const lastDayOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, lastDayOfTarget),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export type BillingPeriod = {
  start: Date;
  end: Date;
  /** 0 for the first period, 1 for the second, and so on. */
  ordinal: number;
};

/**
 * The usage window a given moment falls into.
 *
 * Allowances are monthly whatever the billing cycle — an annual subscriber pays
 * once but still gets 5,300 appointments a month, not 63,600 to spend in
 * January. So periods are monthly windows anchored on the subscription's own
 * start date rather than on the calendar. A hospital that starts on the 15th
 * has periods running the 15th to the 14th.
 *
 * Anchoring on the subscription rather than the calendar month is what makes
 * "usage must correctly belong to the new period" true without a reset job:
 * the boundary is derived, so nothing has to run at midnight to move it.
 */
export function billingPeriod(args: { startsAt: Date; now: Date }): BillingPeriod {
  const { startsAt, now } = args;

  if (now < startsAt) {
    return { start: startsAt, end: addMonthsClamped(startsAt, 1), ordinal: 0 };
  }

  // Approximate, then correct. Day-of-month clamping means the arithmetic
  // estimate can be one period out in either direction.
  let ordinal =
    (now.getUTCFullYear() - startsAt.getUTCFullYear()) * 12 +
    (now.getUTCMonth() - startsAt.getUTCMonth());

  if (addMonthsClamped(startsAt, ordinal) > now) ordinal -= 1;
  while (addMonthsClamped(startsAt, ordinal + 1) <= now) ordinal += 1;

  return {
    start: addMonthsClamped(startsAt, ordinal),
    end: addMonthsClamped(startsAt, ordinal + 1),
    ordinal,
  };
}

/** When a subscription's paid term runs out. */
export const subscriptionEnd = (args: {
  startsAt: Date;
  cycle: BillingCycle;
}): Date => addMonthsClamped(args.startsAt, args.cycle === 'annual' ? 12 : 1);

/**
 * ₹5,000 on monthly, nothing on annual prepay.
 *
 * The waiver is the incentive to prepay rather than a discount in its own
 * right, which is why it is expressed against the tier's own setup fee instead
 * of a hardcoded figure.
 */
export const setupFeePaise = (args: {
  cycle: BillingCycle;
  tierSetupFeePaise: number;
}): number => (args.cycle === 'annual' ? 0 : args.tierSetupFeePaise);

export const subscriptionPricePaise = (args: {
  cycle: BillingCycle;
  monthlyPricePaise: number;
  annualPricePaise: number;
}): number => (args.cycle === 'annual' ? args.annualPricePaise : args.monthlyPricePaise);

/* ------------------------------------------------------------------- usage */

export type UsageLevel = 'normal' | 'warning' | 'critical' | 'exhausted';

export const USAGE_WARNING_PERCENT = 75;
export const USAGE_CRITICAL_PERCENT = 90;

/**
 * Percentage used, or null when there is no allowance to measure against.
 * Null rather than zero, so a missing plan is never rendered as "0% used".
 */
export function usagePercent(used: number, allowance: number): number | null {
  if (allowance <= 0) return null;
  return (used / allowance) * 100;
}

export function usageLevel(percent: number | null): UsageLevel {
  if (percent === null) return 'normal';
  if (percent >= 100) return 'exhausted';
  if (percent >= USAGE_CRITICAL_PERCENT) return 'critical';
  if (percent >= USAGE_WARNING_PERCENT) return 'warning';
  return 'normal';
}

/**
 * Nothing stops at the limit. Overage bills at ₹1 per appointment, and a queue
 * that goes dark mid-morning over a billing threshold is not an acceptable
 * failure mode in a hospital.
 */
export const USAGE_BLOCKS_SERVICE = false;

export type UsageAxis = {
  used: number;
  allowance: number;
  remaining: number;
  percent: number | null;
  level: UsageLevel;
};

export function usageAxis(used: number, allowance: number): UsageAxis {
  const percent = usagePercent(used, allowance);
  return {
    used,
    allowance,
    // Never negative: a hospital past its quota has none left, not minus some.
    remaining: Math.max(0, allowance - used),
    percent,
    level: usageLevel(percent),
  };
}

/* ------------------------------------------------------------------ expiry */

export const EXPIRY_BUCKETS = [
  'expired',
  'tomorrow',
  'within_3_days',
  'within_7_days',
  'within_30_days',
] as const;
export type ExpiryBucket = (typeof EXPIRY_BUCKETS)[number] | null;

const DAY_MS = 24 * 60 * 60 * 1000;

/** How urgently a subscription needs attention. Null means comfortably far off. */
export function expiryBucket(endsAt: Date | null, now: Date): ExpiryBucket {
  if (!endsAt) return null;

  const days = (endsAt.getTime() - now.getTime()) / DAY_MS;
  if (days < 0) return 'expired';
  if (days <= 1) return 'tomorrow';
  if (days <= 3) return 'within_3_days';
  if (days <= 7) return 'within_7_days';
  if (days <= 30) return 'within_30_days';
  return null;
}

export const daysUntilExpiry = (endsAt: Date | null, now: Date): number | null =>
  endsAt ? Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS) : null;
