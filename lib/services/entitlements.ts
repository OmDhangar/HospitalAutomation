import { and, count, eq } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { branches, doctors, staffMemberships } from '@/lib/db/schema';
import {
  checkLimit,
  limitMessage,
  type Entitlements,
  type LimitCheck,
  type LimitKind,
} from '@/lib/domain/entitlements';
import { getCurrentSubscription, listActiveTiers } from './subscriptions';

/**
 * Enforcing what a plan permits, at the point something is added.
 *
 * The check lives here rather than only in the server action because an action
 * is one caller among several — the seed script, an admin tool, and whatever
 * gets written next all reach the same `createDoctor`. A limit that only one
 * entry point respects is a limit that quietly does not exist.
 */

/**
 * A hospital with no subscription is unrestricted rather than frozen out.
 *
 * Every limit here is a commercial boundary, not a safety one, and refusing to
 * let an un-onboarded hospital add its first doctor would break setup for the
 * exact case where nothing has been sold yet. Billing correctness is handled by
 * subscription attribution; this module only decides what a *sold* plan allows.
 */
const UNRESTRICTED: Entitlements = {
  maxBranches: null,
  maxDoctors: null,
  maxStaffLogins: null,
  hasDisplayBoard: true,
  hasOwnerReport: true,
  hasAdvancedReports: true,
  hasDataExport: true,
  hasAuditLog: true,
  supportTier: 'email',
};

/**
 * What this hospital is entitled to right now.
 *
 * Read from the subscription, not from the rate card. The subscription
 * snapshots its entitlements precisely so that repricing a tier cannot reach
 * backwards and change what somebody was sold, and reading `plan_tiers` here
 * would throw that away at the one moment it matters.
 */
export async function getEntitlements(
  hospitalId: string,
  now: Date = new Date(),
): Promise<Entitlements> {
  const subscription = await getCurrentSubscription(hospitalId, now);
  return subscription ?? UNRESTRICTED;
}

async function currentCount(hospitalId: string, kind: LimitKind): Promise<number> {
  return withTenant(hospitalId, async (tx) => {
    // Counted in the database rather than by loading rows: these run on every
    // add, and a hospital's doctor list is not something to pull into memory
    // to measure the length of.
    if (kind === 'branches') {
      const [row] = await tx.select({ value: count() }).from(branches);
      return Number(row?.value ?? 0);
    }
    if (kind === 'doctors') {
      const [row] = await tx
        .select({ value: count() })
        .from(doctors)
        .where(eq(doctors.active, true));
      return Number(row?.value ?? 0);
    }
    const [row] = await tx
      .select({ value: count() })
      .from(staffMemberships)
      .where(and(eq(staffMemberships.hospitalId, hospitalId), eq(staffMemberships.active, true)));
    return Number(row?.value ?? 0);
  });
}

export async function checkCanAdd(args: {
  hospitalId: string;
  kind: LimitKind;
  now?: Date;
}): Promise<LimitCheck> {
  const entitlements = await getEntitlements(args.hospitalId, args.now);
  const current = await currentCount(args.hospitalId, args.kind);
  return checkLimit({ entitlements, kind: args.kind, current });
}

/** Thrown rather than returned, so a caller cannot ignore it by accident. */
export class PlanLimitError extends Error {
  constructor(
    readonly kind: LimitKind,
    readonly limit: number,
    readonly current: number,
    message: string,
  ) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

/**
 * The message names the plan to move to, which means reading the rate card —
 * the one place it is correct to, because this is an offer about what could be
 * bought rather than a statement about what was.
 */
async function nextPlanAllowing(kind: LimitKind, currentLimit: number) {
  const tiers = await listActiveTiers();
  for (const tier of tiers) {
    const limit =
      kind === 'branches'
        ? tier.maxBranches
        : kind === 'doctors'
          ? tier.maxDoctors
          : tier.maxStaffLogins;
    if (limit === null || limit > currentLimit) {
      return { name: tier.name, limit, monthlyPricePaise: tier.monthlyPricePaise };
    }
  }
  return undefined;
}

export async function assertCanAdd(args: {
  hospitalId: string;
  kind: LimitKind;
  now?: Date;
}): Promise<void> {
  const check = await checkCanAdd(args);
  if (check.allowed) return;

  const nextPlan = await nextPlanAllowing(args.kind, check.limit).catch(() => undefined);
  throw new PlanLimitError(
    check.kind,
    check.limit,
    check.current,
    limitMessage(check, nextPlan),
  );
}

/**
 * The sentence shown when somebody has just been refused, or null when they
 * have not. Recomputed from live state rather than carried in the redirect, so
 * what the plan allows never travels through an editable URL.
 */
export async function describeLimit(args: {
  hospitalId: string;
  kind: LimitKind;
  now?: Date;
}): Promise<string | null> {
  const check = await checkCanAdd(args);
  if (check.allowed) return null;

  const nextPlan = await nextPlanAllowing(args.kind, check.limit).catch(() => undefined);
  return limitMessage(check, nextPlan);
}
