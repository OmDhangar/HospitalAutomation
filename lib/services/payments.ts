import { and, desc, eq, gt, isNull, lt } from 'drizzle-orm';
import { withTenant } from '@/lib/db';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, hospitals, payments, planTiers } from '@/lib/db/schema';
import {
  assertReferenceIdFits,
  computeCharge,
  linkExpiryEpochSeconds,
  renewalDescription,
} from '@/lib/domain/billing';
import {
  createPaymentLink,
  fetchPaymentLink,
  isRazorpayConfigured,
  RazorpayError,
} from '@/lib/payments/razorpay';
import type { StaffRole } from './auth';
import { getCurrentSubscription, renewSubscription } from './subscriptions';

/**
 * Collecting subscription money, and turning a confirmed payment into paid
 * time on a plan.
 *
 * The invariant this module exists to protect: a subscription is only ever
 * extended by a payment the gateway has confirmed. Nothing a browser sends can
 * cause it. The amount is computed here from the stored subscription, never
 * accepted from a request, and the extension happens in the webhook — after a
 * verified signature — rather than on the redirect back, which is just a URL
 * anyone can visit.
 */

export class PaymentError extends Error {
  constructor(
    readonly code:
      | 'NOT_CONFIGURED'
      | 'NO_SUBSCRIPTION'
      | 'NOT_PERMITTED'
      | 'GATEWAY_UNAVAILABLE'
      | 'ALREADY_PAID',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentError';
  }
}

const MESSAGES: Record<PaymentError['code'], string> = {
  NOT_CONFIGURED:
    'Online payment is not available yet. Contact your Qurio representative to renew.',
  NO_SUBSCRIPTION: 'There is no plan to renew. Contact your Qurio representative.',
  NOT_PERMITTED: 'Only the hospital owner can make payments.',
  GATEWAY_UNAVAILABLE:
    'The payment page could not be opened just now. Please try again in a few minutes.',
  ALREADY_PAID: 'This payment has already been completed.',
};

export const paymentErrorMessage = (code: PaymentError['code']): string => MESSAGES[code];

export type PaymentActor = { userId: string; role: StaffRole; isPlatformAdmin: boolean };

function assertCanPay(actor: PaymentActor) {
  if (actor.isPlatformAdmin) return;
  if (actor.role !== 'owner') {
    throw new PaymentError('NOT_PERMITTED', MESSAGES.NOT_PERMITTED);
  }
}

/* -------------------------------------------------------------- read model */

export type PaymentView = {
  id: string;
  status: string;
  purpose: string;
  amountPaise: number;
  taxPaise: number;
  totalPaise: number;
  shortUrl: string | null;
  paidAt: Date | null;
  createdAt: Date;
};

export async function listPayments(
  hospitalId: string,
  limit = 12,
): Promise<PaymentView[]> {
  return withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .select({
        id: payments.id,
        status: payments.status,
        purpose: payments.purpose,
        amountPaise: payments.amountPaise,
        taxPaise: payments.taxPaise,
        shortUrl: payments.shortUrl,
        paidAt: payments.paidAt,
        createdAt: payments.createdAt,
      })
      .from(payments)
      .orderBy(desc(payments.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      ...row,
      totalPaise: row.amountPaise + row.taxPaise,
    }));
  });
}

/* ------------------------------------------------------------- create link */

export type RenewalCheckout = {
  paymentId: string;
  url: string;
  totalPaise: number;
  reused: boolean;
};

/**
 * Produces a payment page for renewing the current plan.
 *
 * The amount comes from the subscription the hospital already has, not from
 * the caller. That is the whole security model here: there is no code path in
 * which a request body influences what is charged, so there is nothing to
 * tamper with.
 */
export async function startRenewalCheckout(args: {
  hospitalId: string;
  actor: PaymentActor;
  baseUrl: string;
  timezone: string;
}): Promise<RenewalCheckout> {
  assertCanPay(args.actor);

  if (!isRazorpayConfigured()) {
    throw new PaymentError('NOT_CONFIGURED', MESSAGES.NOT_CONFIGURED);
  }

  const subscription = await getCurrentSubscription(args.hospitalId);
  if (!subscription) throw new PaymentError('NO_SUBSCRIPTION', MESSAGES.NO_SUBSCRIPTION);

  /**
   * Reuse an open link rather than minting a new one per click.
   *
   * A double-clicked button, or an owner returning a day later, would
   * otherwise accumulate live links for the same term — any of which could be
   * paid, and two of which being paid would bill the hospital twice for one
   * month. One open link at a time makes that impossible.
   */
  const existing = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: payments.id,
        shortUrl: payments.shortUrl,
        amountPaise: payments.amountPaise,
        taxPaise: payments.taxPaise,
      })
      .from(payments)
      .where(
        and(
          eq(payments.status, 'created'),
          eq(payments.purpose, 'renewal'),
          gt(payments.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(payments.createdAt))
      .limit(1)
      .then((rows) => rows[0] ?? null),
  );

  if (existing?.shortUrl) {
    return {
      paymentId: existing.id,
      url: existing.shortUrl,
      totalPaise: existing.amountPaise + existing.taxPaise,
      reused: true,
    };
  }

  const charge = computeCharge(subscription.pricePaise);

  const [hospital] = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({ name: hospitals.name, ownerPhone: hospitals.ownerPhoneE164 })
      .from(hospitals)
      .where(eq(hospitals.id, args.hospitalId)),
  );

  const [tier] = await getAdminDb()
    .select({ name: planTiers.name })
    .from(planTiers)
    .where(eq(planTiers.code, subscription.planTierCode));

  // The row is written before the gateway is called, so its id can be the
  // reference Razorpay echoes back. A link created against a row that does not
  // exist yet is a payment we could not attribute.
  const [row] = await withTenant(args.hospitalId, (tx) =>
    tx
      .insert(payments)
      .values({
        hospitalId: args.hospitalId,
        subscriptionId: subscription.id,
        purpose: 'renewal',
        status: 'created',
        amountPaise: charge.amountPaise,
        taxPaise: charge.taxPaise,
        notes: {
          planTierCode: subscription.planTierCode,
          billingCycle: subscription.billingCycle,
          gstPercent: charge.gstPercent,
        },
      })
      .returning({ id: payments.id }),
  );

  const description = renewalDescription({
    hospitalName: hospital?.name ?? 'Hospital',
    planName: tier?.name ?? subscription.planTierCode,
    billingCycle: subscription.billingCycle,
    periodStart: subscription.endsAt > new Date() ? subscription.endsAt : new Date(),
    timezone: args.timezone,
  });

  let link;
  try {
    link = await createPaymentLink({
      amountPaise: charge.totalPaise,
      referenceId: assertReferenceIdFits(row.id),
      description,
      callbackUrl: `${args.baseUrl}/subscription?payment=done`,
      expireBy: linkExpiryEpochSeconds(),
      customer: hospital?.ownerPhone ? { contact: hospital.ownerPhone } : undefined,
      notes: { hospital_id: args.hospitalId, payment_id: row.id },
    });
  } catch (error) {
    // Mark it failed rather than leaving a 'created' row with no link, which
    // would be reused forever by the branch above and never be payable.
    await withTenant(args.hospitalId, (tx) =>
      tx
        .update(payments)
        .set({
          status: 'failed',
          failureReason: error instanceof RazorpayError ? 'gateway_error' : 'unknown',
          updatedAt: new Date(),
        })
        .where(eq(payments.id, row.id)),
    );

    console.error(
      '[payments:link_failed]',
      JSON.stringify({
        hospital_id: args.hospitalId,
        payment_id: row.id,
        provider_code: error instanceof RazorpayError ? error.providerCode : undefined,
      }),
    );

    throw new PaymentError('GATEWAY_UNAVAILABLE', MESSAGES.GATEWAY_UNAVAILABLE);
  }

  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .update(payments)
      .set({
        providerLinkId: link.id,
        shortUrl: link.shortUrl,
        expiresAt: new Date(linkExpiryEpochSeconds() * 1000),
        updatedAt: new Date(),
      })
      .where(eq(payments.id, row.id));

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actor.userId,
      action: 'payment.link.created',
      objectType: 'payment',
      objectId: row.id,
      metadata: {
        provider: 'razorpay',
        purpose: 'renewal',
        amount_paise: charge.amountPaise,
        tax_paise: charge.taxPaise,
        provider_link_id: link.id,
      },
    });
  });

  return {
    paymentId: row.id,
    url: link.shortUrl,
    totalPaise: charge.totalPaise,
    reused: false,
  };
}

/* ------------------------------------------------------------ settlement */

export type SettlementResult =
  | { outcome: 'renewed'; paymentId: string }
  | { outcome: 'already_processed'; paymentId: string }
  | { outcome: 'unknown_reference' };

/**
 * Turns a gateway-confirmed payment into paid time on the plan.
 *
 * Runs on the admin connection: a webhook arrives with no session and no
 * tenant context, which is exactly the system-level case that connection
 * exists for.
 *
 * Idempotent by database constraint, not by checking first. Razorpay retries
 * until it gets a 2xx, and two retries racing each other would both pass a
 * read-then-write guard and extend the subscription twice — a free month per
 * duplicate. The unique index on provider_payment_id makes the second write
 * fail instead.
 */
export async function settlePayment(args: {
  referenceId: string | null;
  providerPaymentId: string | null;
  providerLinkId: string | null;
  amountPaise: number | null;
}): Promise<SettlementResult> {
  if (!args.referenceId || !args.providerPaymentId) {
    return { outcome: 'unknown_reference' };
  }

  const db = getAdminDb();

  const [existing] = await db
    .select({
      id: payments.id,
      hospitalId: payments.hospitalId,
      status: payments.status,
      amountPaise: payments.amountPaise,
      taxPaise: payments.taxPaise,
    })
    .from(payments)
    .where(eq(payments.id, args.referenceId));

  if (!existing) return { outcome: 'unknown_reference' };

  if (existing.status === 'paid') {
    return { outcome: 'already_processed', paymentId: existing.id };
  }

  /**
   * Claim the row before doing anything with consequences.
   *
   * The WHERE clause requires the status still to be 'created', so of two
   * concurrent deliveries exactly one updates a row and the other matches
   * nothing. Whoever wins the claim does the renewal.
   */
  const claimed = await db
    .update(payments)
    .set({
      status: 'paid',
      providerPaymentId: args.providerPaymentId,
      providerLinkId: args.providerLinkId ?? undefined,
      paidAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(payments.id, existing.id), eq(payments.status, 'created')))
    .returning({ id: payments.id });

  if (claimed.length === 0) {
    return { outcome: 'already_processed', paymentId: existing.id };
  }

  // Mismatched amounts are recorded and still honoured: the money arrived, and
  // refusing to extend the plan would punish the hospital for our accounting
  // problem. It is flagged loudly for a human to reconcile.
  const expected = existing.amountPaise + existing.taxPaise;
  if (args.amountPaise !== null && args.amountPaise !== expected) {
    console.error(
      '[payments:amount_mismatch]',
      JSON.stringify({
        payment_id: existing.id,
        hospital_id: existing.hospitalId,
        expected_paise: expected,
        received_paise: args.amountPaise,
      }),
    );
  }

  await renewSubscription({ hospitalId: existing.hospitalId });

  await db.insert(auditLogs).values({
    hospitalId: existing.hospitalId,
    // No actor: this was the gateway, not a signed-in person.
    actorUserId: null,
    action: 'payment.settled',
    objectType: 'payment',
    objectId: existing.id,
    metadata: {
      provider: 'razorpay',
      provider_payment_id: args.providerPaymentId,
      amount_paise: existing.amountPaise,
      tax_paise: existing.taxPaise,
      result: 'success',
    },
  });

  console.log(
    '[payments:settled]',
    JSON.stringify({
      payment_id: existing.id,
      hospital_id: existing.hospitalId,
      amount_paise: expected,
      result: 'success',
    }),
  );

  return { outcome: 'renewed', paymentId: existing.id };
}

/**
 * Reconciles one payment against the gateway.
 *
 * The safety net for a webhook that never arrived — misconfigured endpoint,
 * a deploy during the callback, Razorpay giving up after its retries. Called
 * when the owner lands back on the subscription page, so someone who has
 * genuinely paid gets their plan extended by reloading rather than by waiting
 * for us to notice.
 */
export async function reconcilePayment(args: {
  hospitalId: string;
  paymentId: string;
}): Promise<SettlementResult> {
  const [row] = await withTenant(args.hospitalId, (tx) =>
    tx
      .select({
        id: payments.id,
        status: payments.status,
        providerLinkId: payments.providerLinkId,
      })
      .from(payments)
      .where(eq(payments.id, args.paymentId)),
  );

  if (!row) return { outcome: 'unknown_reference' };
  if (row.status === 'paid') {
    return { outcome: 'already_processed', paymentId: row.id };
  }
  if (!row.providerLinkId) return { outcome: 'unknown_reference' };

  const link = await fetchPaymentLink(row.providerLinkId);
  if (link.status !== 'paid') return { outcome: 'unknown_reference' };

  return settlePayment({
    referenceId: row.id,
    // Razorpay's link object does not carry the payment id, so the link id
    // stands in as the idempotency key. It is equally unique per settlement.
    providerPaymentId: `plink:${link.id}`,
    providerLinkId: link.id,
    amountPaise: link.amount,
  });
}

/**
 * Marks links nobody paid before they lapsed, so the page stops offering a URL
 * Razorpay will refuse.
 *
 * Scoped to rows whose own expiry has actually passed — matching on status
 * alone would close every live link, including one an owner is paying right
 * now. Idempotent, so it is safe to call from the worker tick.
 */
export async function expireStalePaymentLinks(now: Date = new Date()) {
  return getAdminDb()
    .update(payments)
    .set({ status: 'expired', updatedAt: now })
    .where(
      and(
        eq(payments.status, 'created'),
        isNull(payments.paidAt),
        lt(payments.expiresAt, now),
      ),
    );
}
