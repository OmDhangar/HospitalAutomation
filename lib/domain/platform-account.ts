import type { LimitKind } from './entitlements';
import {
  daysUntilExpiry,
  expiryBucket,
  usageLevel,
  usagePercent,
  type ExpiryBucket,
  type SubscriptionStatus,
  type UsageLevel,
} from './subscription';

/**
 * How an account reads at a glance, from the operator's side of the product.
 *
 * Everything here is pure, for the same reason the entitlement rules are: the
 * question "is this customer in trouble" gets asked on a list of every hospital
 * at once, and it should be answerable without a database and arguable in a
 * test rather than in a support call.
 */

/* ------------------------------------------------------------- standing */

/**
 * Ordered worst-first. A list sorted on this puts the accounts that need a
 * phone call today at the top, which is the only ordering an operator console
 * is actually used with.
 */
export const ACCOUNT_STANDINGS = [
  'suspended',
  'expired',
  'lapsing',
  'over_limit',
  'unbilled',
  'trial',
  'healthy',
] as const;
export type AccountStanding = (typeof ACCOUNT_STANDINGS)[number];

export const STANDING_RANK: Record<AccountStanding, number> = ACCOUNT_STANDINGS.reduce(
  (acc, standing, index) => ({ ...acc, [standing]: index }),
  {} as Record<AccountStanding, number>,
);

export type StandingInput = {
  /** `hospitals.active` — switched off by us, not by the plan running out. */
  hospitalActive: boolean;
  subscriptionStatus: SubscriptionStatus | null;
  endsAt: Date | null;
  /** True when any entitlement axis is at or past its cap. */
  overLimit: boolean;
  now: Date;
};

/**
 * One label per account, chosen worst-first.
 *
 * The order is the argument. A suspended hospital that is also over its doctor
 * limit is a suspended hospital — the limit is irrelevant until it is turned
 * back on — so the checks cascade rather than combine, and the first one that
 * matches wins.
 */
export function accountStanding(input: StandingInput): AccountStanding {
  // Deliberately first: an account we switched off is off, whatever its
  // subscription says. The two are separate levers and this is the stronger.
  if (!input.hospitalActive) return 'suspended';
  if (input.subscriptionStatus === 'suspended') return 'suspended';
  if (input.subscriptionStatus === 'cancelled') return 'expired';
  if (input.subscriptionStatus === 'expired') return 'expired';

  // No subscription at all is not the same as a lapsed one. It is a hospital
  // that was set up and never put on a plan — our billing omission, not their
  // payment failure, and it stays visible until somebody fixes it.
  if (input.subscriptionStatus === null) return 'unbilled';

  const bucket = expiryBucket(input.endsAt, input.now);
  if (bucket === 'expired') return 'expired';
  if (bucket === 'tomorrow' || bucket === 'within_3_days' || bucket === 'within_7_days') {
    return 'lapsing';
  }

  // Ranked below expiry because being over a limit costs the customer nothing
  // today, whereas a plan running out this week cuts service off.
  if (input.overLimit) return 'over_limit';
  if (input.subscriptionStatus === 'trial') return 'trial';
  return 'healthy';
}

export const STANDING_LABEL: Record<AccountStanding, string> = {
  suspended: 'Suspended',
  expired: 'Expired',
  lapsing: 'Lapsing',
  over_limit: 'Over limit',
  unbilled: 'No plan',
  trial: 'Trial',
  healthy: 'Healthy',
};

/** Whether this account belongs on the "needs attention" list. */
export const needsAttention = (standing: AccountStanding): boolean =>
  standing !== 'healthy' && standing !== 'trial';

/* ---------------------------------------------------------- entitlements */

/**
 * One entitlement axis, measured.
 *
 * Separate from `UsageAxis` because a null limit means unlimited here, where a
 * zero allowance there means unmeasurable. Collapsing the two would render an
 * enterprise account's unlimited branches as "0% used".
 */
export type EntitlementAxis = {
  kind: LimitKind;
  used: number;
  /** Null is unlimited, which is a different statement from a large number. */
  limit: number | null;
  percent: number | null;
  level: UsageLevel;
  /** At or past the cap — the point where the next addition is refused. */
  atLimit: boolean;
};

export function entitlementAxis(
  kind: LimitKind,
  used: number,
  limit: number | null,
): EntitlementAxis {
  if (limit === null) {
    return { kind, used, limit: null, percent: null, level: 'normal', atLimit: false };
  }

  const percent = usagePercent(used, limit);
  return {
    kind,
    used,
    limit,
    percent,
    level: usageLevel(percent),
    /**
     * `>=`, not `>`. A hospital with three of three doctors has not exceeded
     * anything, but it cannot add a fourth — and "can they add one more" is
     * the question this flag is read to answer.
     */
    atLimit: used >= limit,
  };
}

export const ENTITLEMENT_LABEL: Record<LimitKind, string> = {
  branches: 'Branches',
  doctors: 'Doctors',
  staff: 'Staff logins',
};

/* ------------------------------------------------------------------ term */

export type TermView = {
  endsAt: Date | null;
  bucket: ExpiryBucket;
  daysRemaining: number | null;
};

export function termView(endsAt: Date | null, now: Date): TermView {
  return {
    endsAt,
    bucket: expiryBucket(endsAt, now),
    daysRemaining: daysUntilExpiry(endsAt, now),
  };
}

/* ---------------------------------------------------------------- money */

/**
 * Monthly recurring revenue for one account, normalised.
 *
 * An annual subscription is not twelve times its monthly price — it is ten —
 * so dividing the agreed annual figure by twelve is the only way a portfolio
 * total means anything when the two cycles are mixed. Reading the monthly rate
 * card instead would overstate every annual customer by twenty percent.
 */
export function normalisedMrrPaise(args: {
  pricePaise: number;
  billingCycle: 'monthly' | 'annual';
}): number {
  return args.billingCycle === 'annual'
    ? Math.round(args.pricePaise / 12)
    : args.pricePaise;
}

/** Discounts are stored as whole percent off the list price. */
export function discountedPaise(listPaise: number, discountPercent: number): number {
  const clamped = Math.min(100, Math.max(0, discountPercent));
  return Math.round(listPaise * (1 - clamped / 100));
}
