import { and, desc, eq, isNull, lt } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
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

/** The subscription in force right now, or null for a hospital never onboarded. */
export async function getCurrentSubscription(
  hospitalId: string,
): Promise<Subscription | null> {
  return withTenant(hospitalId, async (tx) => {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.hospitalId, hospitalId),
          isNull(subscriptions.supersededAt),
        ),
      );
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

/**
 * The published rate card, ordered as it should be displayed.
 *
 * Read from the database on every request rather than from the seed constants,
 * so a negotiated price or a deactivated tier is reflected everywhere without a
 * deploy. Nothing in the UI may hardcode these figures.
 */
export async function listActiveTiers(): Promise<Tier[]> {
  return getAdminDb()
    .select()
    .from(planTiers)
    .where(eq(planTiers.active, true))
    .orderBy(planTiers.sortOrder);
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
  const current = await getCurrentSubscription(args.hospitalId);
  if (!current) throw new Error('No subscription to renew');

  return startSubscription({
    hospitalId: args.hospitalId,
    tierCode: current.planTierCode,
    billingCycle: current.billingCycle,
    // A renewal begins when the previous term ended, not when someone got
    // round to clicking the button — otherwise every renewal silently gifts
    // the customer the gap.
    startsAt: current.endsAt > new Date() ? current.endsAt : new Date(),
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
