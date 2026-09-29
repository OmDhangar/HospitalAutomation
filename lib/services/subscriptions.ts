import { and, desc, eq, gt, isNull, lt, lte, or } from 'drizzle-orm';
import { withTenant, type Tx } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, hospitals, planTiers, subscriptions } from '@/lib/db/schema';
import {
  setupFeePaise,
  subscriptionEnd,
  subscriptionPricePaise,
  type BillingCycle,
  type SubscriptionStatus,
} from '@/lib/domain/subscription';

export type Subscription = typeof subscriptions.$inferSelect;
export type Tier = typeof planTiers.$inferSelect;

/**
 * The one authoritative answer to "which term covered this hospital at this
 * instant".
 *
 * Everything — the dashboard, historical usage, appointment attribution,
 * message attribution, reconciliation — resolves through here, so there is one
 * definition of coverage rather than a slightly different `where` clause per
 * service.
 *
 * The term is `[starts_at, ends_at)`: start inclusive, end exclusive. That is
 * what removes the boundary ambiguity — 30 Sep 23:59:59 belongs to September
 * and 1 Oct 00:00:00 belongs to October, with no instant belonging to both or
 * to neither.
 *
 * `superseded_at` is deliberately not read as a boolean. It records when a row
 * was administratively replaced, and on an early renewal that is a *future*
 * timestamp — the old term is superseded on the day the new one begins, not on
 * the day somebody clicked Renew. Testing `superseded_at IS NULL` is what
 * removed a still-running term from view the moment its successor was written,
 * which zeroed the dashboard and left the messages sent in between attributed
 * to no plan at all. Compared against `at`, the same column behaves correctly.
 *
 * Status is not filtered here, and that is a decision rather than an omission.
 * Status describes what a term is doing *now*; this function answers what a
 * term covered *then*. A September term later marked `expired` still owns
 * September's usage, and excluding it would reintroduce the same class of bug
 * one layer down. Callers that need "may this hospital be served right now"
 * ask `isServing(subscription.status)` separately.
 */
export async function getSubscriptionEffectiveAt(
  hospitalId: string,
  at: Date,
): Promise<Subscription | null> {
  return withTenant(hospitalId, (tx) =>
    getSubscriptionEffectiveAtInTx(tx, hospitalId, at),
  );
}

export async function getSubscriptionEffectiveAtInTx(
  tx: Tx,
  hospitalId: string,
  at: Date,
): Promise<Subscription | null> {
  const [row] = await tx
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.hospitalId, hospitalId),
        lte(subscriptions.startsAt, at),
        gt(subscriptions.endsAt, at),
        or(isNull(subscriptions.supersededAt), gt(subscriptions.supersededAt, at)),
      ),
    )
    // Overlapping terms should not exist, but ordering makes the answer
    // deterministic if one ever does: the later term wins, which is the one a
    // human would have intended by creating it.
    .orderBy(desc(subscriptions.startsAt))
    .limit(1);

  return row ?? null;
}

/** The subscription in force right now, or null for a hospital never onboarded. */
export async function getCurrentSubscription(
  hospitalId: string,
  now: Date = new Date(),
): Promise<Subscription | null> {
  return withTenant(hospitalId, (tx) =>
    getSubscriptionEffectiveAtInTx(tx, hospitalId, now),
  );
}

export async function getCurrentSubscriptionInTx(
  tx: Tx,
  hospitalId: string,
  now: Date = new Date(),
): Promise<Subscription | null> {
  return getSubscriptionEffectiveAtInTx(tx, hospitalId, now);
}

/**
 * A term that has been paid for but has not started yet.
 *
 * Early renewal is a normal state, not an edge case, and the two rows have to
 * be shown as two rows. Before this existed the upcoming term was simply
 * returned as the current one, which is the bug this module now guards against.
 */
export async function getUpcomingSubscription(
  hospitalId: string,
  now: Date = new Date(),
): Promise<Subscription | null> {
  return withTenant(hospitalId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.hospitalId, hospitalId),
          gt(subscriptions.startsAt, now),
          /**
           * A term replaced before it ever began never takes effect and is not
           * "upcoming". One replaced after it begins — every ordinary renewal,
           * where `superseded_at` is the day the successor starts — is. Testing
           * for NULL alone would hide October the moment November was bought.
           */
          or(
            isNull(subscriptions.supersededAt),
            gt(subscriptions.supersededAt, subscriptions.startsAt),
          ),
        ),
      )
      .orderBy(subscriptions.startsAt)
      .limit(1);

    return row ?? null;
  });
}

/**
 * The furthest-future term on the books, which is what a renewal extends.
 *
 * Distinct from both "current" and "next": after two early renewals a hospital
 * holds three terms, and a third renewal has to begin where the last one ends,
 * not where today's does.
 */
export async function getLatestSubscriptionTerm(
  hospitalId: string,
): Promise<Subscription | null> {
  return withTenant(hospitalId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.hospitalId, hospitalId),
          or(
            isNull(subscriptions.supersededAt),
            gt(subscriptions.supersededAt, subscriptions.startsAt),
          ),
        ),
      )
      .orderBy(desc(subscriptions.endsAt))
      .limit(1);

    return row ?? null;
  });
}

/** Every subscription this hospital has had, newest first. */
export async function getSubscriptionHistory(
  hospitalId: string,
): Promise<Subscription[]> {
  return withTenant(hospitalId, (tx) =>
    tx
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.hospitalId, hospitalId))
      .orderBy(desc(subscriptions.startsAt)),
  );
}

// In-memory cache for active tiers (60s TTL)
type TierCacheEntry = { data: Tier[]; expiresAt: number };
let tierCache: TierCacheEntry | null = null;
const TIER_CACHE_TTL = 60_000;

export function clearTierCache() {
  tierCache = null;
}

/**
 * The published rate card, ordered as it should be displayed.
 *
 * Read from the database and cached for 60s, so changes reflect quickly
 * without hitting the admin DB on every dashboard load.
 */
export async function listActiveTiers(): Promise<Tier[]> {
  if (tierCache && tierCache.expiresAt > Date.now()) {
    return tierCache.data;
  }

  const tiers = await getAdminDb()
    .select()
    .from(planTiers)
    .where(eq(planTiers.active, true))
    .orderBy(planTiers.sortOrder);

  tierCache = { data: tiers, expiresAt: Date.now() + TIER_CACHE_TTL };
  return tiers;
}

async function tierOrThrow(code: string): Promise<Tier> {
  const [row] = await getAdminDb()
    .select()
    .from(planTiers)
    .where(eq(planTiers.code, code));
  if (!row) throw new Error(`Unknown plan tier: ${code}`);
  return row;
}

/**
 * Starts a subscription, superseding whatever came before.
 *
 * Runs on the admin connection because assigning a plan is a platform-operator
 * action across tenants, and because it writes `hospitals.plan_tier_code` in the
 * same transaction. That column is a mirror kept only so existing readers keep
 * working; `subscriptions` is the source of truth, and one function owning both
 * writes is what stops the two drifting.
 */
export async function startSubscription(args: {
  hospitalId: string;
  tierCode: string;
  billingCycle: BillingCycle;
  status?: SubscriptionStatus;
  startsAt?: Date;
  changeReason: string;
  changedByUserId?: string | null;
  /** Overrides the rate card, for a negotiated or founding-customer rate. */
  pricePaiseOverride?: number;
  waiveSetupFee?: boolean;
}): Promise<Subscription> {
  const tier = await tierOrThrow(args.tierCode);
  const db = getAdminDb();
  const startsAt = args.startsAt ?? new Date();

  const price =
    args.pricePaiseOverride ??
    subscriptionPricePaise({
      cycle: args.billingCycle,
      monthlyPricePaise: tier.monthlyPricePaise,
      annualPricePaise: tier.annualPricePaise,
    });

  const setupFee = args.waiveSetupFee
    ? 0
    : setupFeePaise({
        cycle: args.billingCycle,
        tierSetupFeePaise: tier.setupFeePaise,
      });

  return db.transaction(async (tx) => {
    // Close the previous term before opening the next: the unique index allows
    // only one non-superseded subscription per hospital, so this ordering is
    // enforced rather than merely intended.
    await tx
      .update(subscriptions)
      .set({ supersededAt: startsAt, updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.hospitalId, args.hospitalId),
          isNull(subscriptions.supersededAt),
        ),
      );

    const [created] = await tx
      .insert(subscriptions)
      .values({
        hospitalId: args.hospitalId,
        planTierCode: tier.code,
        billingCycle: args.billingCycle,
        status: args.status ?? 'active',
        pricePaise: price,
        setupFeePaise: setupFee,
        dailyAppointmentCapacity: tier.patientsPerDay,
        includedAppointments: tier.includedAppointments,
        includedMessages: tier.includedMessages,
        /**
         * Snapshotted from the rate card for the same reason the allowances
         * above are, and easy to leave out: every one of these columns is
         * nullable or defaulted, so omitting them produced a subscription with
         * no limits at all rather than an error. Migration 0021 backfilled the
         * terms that existed then; without this, every term opened since has
         * been silently unlimited on all three axes and `assertCanAdd` has
         * never refused anything.
         */
        maxBranches: tier.maxBranches,
        maxDoctors: tier.maxDoctors,
        maxStaffLogins: tier.maxStaffLogins,
        hasDisplayBoard: tier.hasDisplayBoard,
        hasOwnerReport: tier.hasOwnerReport,
        hasAdvancedReports: tier.hasAdvancedReports,
        hasDataExport: tier.hasDataExport,
        hasAuditLog: tier.hasAuditLog,
        supportTier: tier.supportTier,
        startsAt,
        endsAt: subscriptionEnd({ startsAt, cycle: args.billingCycle }),
        changeReason: args.changeReason,
        changedByUserId: args.changedByUserId ?? null,
      })
      .returning();

    await tx
      .update(hospitals)
      .set({ planTierCode: tier.code, updatedAt: new Date() })
      .where(eq(hospitals.id, args.hospitalId));

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.changedByUserId ?? null,
      action: `subscription.${args.changeReason}`,
      objectType: 'subscription',
      objectId: created.id,
      metadata: {
        tier: tier.code,
        billingCycle: args.billingCycle,
        pricePaise: price,
        setupFeePaise: setupFee,
      },
    });

    return created;
  });
}

/**
 * Moves a hospital to a different tier or cycle, immediately.
 *
 * Deferred downgrades — taking effect only at the end of a paid term — are not
 * built. Doing that properly needs a scheduled-change record, since the unique
 * index permits exactly one current subscription and a future-dated row would
 * violate it. Until then a downgrade applies at once, so it is worth timing
 * one for a period boundary rather than mid-term.
 */
export async function changeSubscriptionTier(args: {
  hospitalId: string;
  tierCode: string;
  billingCycle: BillingCycle;
  changedByUserId?: string | null;
  reason?: string;
}): Promise<Subscription> {
  const current = await getCurrentSubscription(args.hospitalId);
  const next = await tierOrThrow(args.tierCode);

  const direction = !current
    ? 'initial'
    : next.includedAppointments > current.includedAppointments
      ? 'upgrade'
      : next.includedAppointments < current.includedAppointments
        ? 'downgrade'
        : 'cycle_change';

  return startSubscription({
    hospitalId: args.hospitalId,
    tierCode: args.tierCode,
    billingCycle: args.billingCycle,
    changeReason: args.reason ?? direction,
    changedByUserId: args.changedByUserId,
  });
}

/** Extends the paid term on the same tier and cycle. */
export async function renewSubscription(args: {
  hospitalId: string;
  changedByUserId?: string | null;
}): Promise<Subscription> {
  const now = new Date();
  /**
   * Chained from the furthest-future term, not the one running today.
   *
   * These differ precisely when a renewal has already been bought and has not
   * started — which is the state this module now models properly. Renewing
   * from the *current* term would set the new one to begin when September
   * ends, landing it on top of the October term already sitting there. The
   * last term on the books is the one a renewal extends.
   */
  const current = await getLatestSubscriptionTerm(args.hospitalId);
  if (!current) throw new Error('No subscription to renew');

  return startSubscription({
    hospitalId: args.hospitalId,
    tierCode: current.planTierCode,
    billingCycle: current.billingCycle,
    // A renewal begins when the previous term ended, not when someone got
    // round to clicking the button — otherwise every renewal silently gifts
    // the customer the gap.
    startsAt: current.endsAt > now ? current.endsAt : now,
    changeReason: 'renewal',
    changedByUserId: args.changedByUserId,
    pricePaiseOverride: current.pricePaise,
    waiveSetupFee: true,
  });
}

/** Suspend, cancel or reactivate without starting a new term. */
export async function setSubscriptionStatus(args: {
  hospitalId: string;
  status: SubscriptionStatus;
  changedByUserId?: string | null;
}) {
  const db = getAdminDb();

  return db.transaction(async (tx) => {
    await tx
      .update(subscriptions)
      .set({
        status: args.status,
        cancelledAt: args.status === 'cancelled' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subscriptions.hospitalId, args.hospitalId),
          isNull(subscriptions.supersededAt),
        ),
      );

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.changedByUserId ?? null,
      action: `subscription.status.${args.status}`,
      objectType: 'subscription',
      metadata: { status: args.status },
    });
  });
}

/** Pushes the expiry date out without changing tier, price or cycle. */
export async function extendExpiry(args: {
  hospitalId: string;
  endsAt: Date;
  changedByUserId?: string | null;
}) {
  const db = getAdminDb();

  return db.transaction(async (tx) => {
    await tx
      .update(subscriptions)
      .set({ endsAt: args.endsAt, status: 'active', updatedAt: new Date() })
      .where(
        and(
          eq(subscriptions.hospitalId, args.hospitalId),
          isNull(subscriptions.supersededAt),
        ),
      );

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.changedByUserId ?? null,
      action: 'subscription.extend',
      objectType: 'subscription',
      metadata: { endsAt: args.endsAt.toISOString() },
    });
  });
}

/**
 * Marks lapsed subscriptions expired. Idempotent, so it is safe to call from
 * the worker tick as often as that runs.
 */
export async function expireLapsedSubscriptions(now: Date = new Date()) {
  const db = getAdminDb();
  const rows = await db
    .update(subscriptions)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        isNull(subscriptions.supersededAt),
        eq(subscriptions.status, 'active'),
        lt(subscriptions.endsAt, now),
      ),
    )
    .returning({ id: subscriptions.id });

  return rows.length;
}
