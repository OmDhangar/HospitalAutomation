import { desc, eq, like } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, hospitals, planTiers } from '@/lib/db/schema';
import {
  customTierCode,
  quoteCustomPlan,
  type CustomPlanInput,
  type CustomPlanQuote,
} from '@/lib/domain/custom-plan';
import { WORKING_DAYS_PER_MONTH } from '@/lib/domain/pricing';
import { startSubscription } from './subscriptions';

/**
 * Bespoke plans for hospitals the published ladder does not fit.
 *
 * A custom plan is an ordinary `plan_tiers` row with `active = false`. That
 * one flag does all the work: `listActiveTiers` drives the public pricing page
 * and the tier recommender, so an inactive row is invisible to both, while
 * `startSubscription` reads tiers by code and neither knows nor cares that this
 * one was built for a single customer.
 *
 * Nothing new was needed to make a subscription understand a bespoke plan,
 * because a subscription already snapshots price, allowances and entitlements
 * at signing. The custom row is only the template the snapshot is taken from.
 */

export class CustomPlanError extends Error {
  constructor(
    readonly code: 'HOSPITAL_NOT_FOUND' | 'CODE_TAKEN' | 'INVALID_INPUT',
    message: string,
  ) {
    super(message);
    this.name = 'CustomPlanError';
  }
}

export type CreateCustomPlanArgs = {
  hospitalId: string;
  /** Shown on the pricing select and on the invoice, e.g. "Apollo Pune — bespoke". */
  name: string;
  /** The operator's final price, which may differ from the suggestion. */
  monthlyPricePaise: number;
  annualPricePaise: number;
  setupFeePaise: number;
  patientsPerDay: number;
  includedAppointments: number;
  includedMessages: number;
  maxBranches: number | null;
  maxDoctors: number | null;
  maxStaffLogins: number | null;
  supportTier: string;
  hasDisplayBoard: boolean;
  hasOwnerReport: boolean;
  hasAdvancedReports: boolean;
  hasDataExport: boolean;
  hasAuditLog: boolean;
  /** Whether to move the hospital onto it immediately. */
  assign: boolean;
  billingCycle: 'monthly' | 'annual';
  actorUserId: string;
};

export async function createCustomPlan(args: CreateCustomPlanArgs): Promise<{ code: string }> {
  if (args.monthlyPricePaise < 0 || args.includedAppointments < 0) {
    throw new CustomPlanError('INVALID_INPUT', 'Price and allowances cannot be negative.');
  }

  const db = getAdminDb();

  const [hospital] = await db
    .select({ id: hospitals.id, slug: hospitals.slug, name: hospitals.name })
    .from(hospitals)
    .where(eq(hospitals.id, args.hospitalId));

  if (!hospital) throw new CustomPlanError('HOSPITAL_NOT_FOUND', 'No such hospital.');

  /**
   * A hospital may be repriced more than once, and a superseded subscription
   * still points at the tier it was sold on. Reusing the code would rewrite
   * the terms of a closed agreement, so each revision gets its own row.
   */
  const baseCode = customTierCode(hospital.slug);
  const existing = await db
    .select({ code: planTiers.code })
    .from(planTiers)
    .where(like(planTiers.code, `${baseCode}%`));

  const code = existing.length === 0 ? baseCode : `${baseCode}_v${existing.length + 1}`;

  await db.transaction(async (tx) => {
    await tx.insert(planTiers).values({
      code,
      name: args.name.trim() || `${hospital.name} — bespoke`,
      patientsPerDay: args.patientsPerDay,
      includedAppointments: args.includedAppointments,
      includedMessages: args.includedMessages,
      monthlyPricePaise: args.monthlyPricePaise,
      annualPricePaise: args.annualPricePaise,
      setupFeePaise: args.setupFeePaise,
      maxBranches: args.maxBranches,
      maxDoctors: args.maxDoctors,
      maxStaffLogins: args.maxStaffLogins,
      hasDisplayBoard: args.hasDisplayBoard,
      hasOwnerReport: args.hasOwnerReport,
      hasAdvancedReports: args.hasAdvancedReports,
      hasDataExport: args.hasDataExport,
      hasAuditLog: args.hasAuditLog,
      supportTier: args.supportTier,
      /**
       * The load-bearing flag. Inactive keeps this off the public pricing page
       * and out of `recommendTier`, so a price negotiated for one hospital is
       * never quoted to another.
       */
      active: false,
      // Below every published tier, so if it ever did surface it sorts last.
      sortOrder: 99,
    });

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'platform.custom_plan.created',
      objectType: 'plan_tier',
      objectId: code,
      metadata: {
        code,
        monthlyPricePaise: args.monthlyPricePaise,
        patientsPerDay: args.patientsPerDay,
      },
    });
  });

  /**
   * Assignment is a separate step by design. `startSubscription` opens a new
   * term and supersedes the old one, and doing that inside the transaction
   * above would mean a failed assignment rolled back a perfectly good plan
   * definition the operator would then have to rebuild.
   */
  if (args.assign) {
    await startSubscription({
      hospitalId: args.hospitalId,
      tierCode: code,
      billingCycle: args.billingCycle,
      changeReason: 'custom_plan',
      changedByUserId: args.actorUserId,
    });
  }

  return { code };
}

/**
 * Every tier an operator may assign, published and bespoke.
 *
 * Distinct from `listActiveTiers`, which is the public rate card. The console
 * needs to see an inactive custom plan in order to put a hospital back onto one
 * after a change; the pricing page must never see it.
 */
export async function listAssignableTiers() {
  return getAdminDb()
    .select()
    .from(planTiers)
    .orderBy(planTiers.active, planTiers.sortOrder, desc(planTiers.monthlyPricePaise));
}

/** Bespoke plans only, newest first, for the console's plans view. */
export async function listCustomPlans() {
  return getAdminDb()
    .select()
    .from(planTiers)
    .where(like(planTiers.code, 'custom_%'))
    .orderBy(planTiers.code);
}

/**
 * Re-derives the quote a plan was built from, for the console to show
 * alongside the stored price.
 *
 * The inputs are not stored: `patients_per_day` is on the tier, and everything
 * else is either a live cost figure or a policy constant. Recomputing means a
 * plan quoted six months ago is re-judged against today's real cost per
 * message rather than the one assumed at the time — which is exactly the
 * question worth asking of a bespoke account.
 */
export function requoteFromTier(args: {
  patientsPerDay: number;
  branches: number;
  doctors: number;
  staffLogins: number;
  paisePerMessage: number;
  targetMargin: number;
  billingCycle: 'monthly' | 'annual';
}): CustomPlanQuote {
  const input: CustomPlanInput = { ...args };
  return quoteCustomPlan(input);
}

export { WORKING_DAYS_PER_MONTH };
