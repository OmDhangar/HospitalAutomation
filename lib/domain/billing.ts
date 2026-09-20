/**
 * What a hospital is charged, and how that number is arrived at.
 *
 * Pure, and kept apart from the Razorpay client on purpose: the amount on an
 * invoice is a business fact that has to be right whether or not a gateway is
 * reachable, and it is the one part of payments worth testing exhaustively.
 * Everything here works in integer paise — a rupee figure that came from
 * floating point has no business on an invoice.
 */

/** Standard rate on SaaS in India. */
export const GST_PERCENT = 18;

/**
 * Whether tax is added to what the hospital pays.
 *
 * Off until the company is GST registered, because charging tax without a
 * GSTIN to remit it against is not a rounding error, it is a compliance
 * problem. Once registered this flips to true and every subsequent payment
 * carries its tax as a separate line — historic rows keep whatever they were
 * charged, which is why `tax_paise` is stored per payment rather than derived
 * at display time.
 */
export function gstEnabled(): boolean {
  return process.env.BILLING_GST_ENABLED === 'true';
}

export type Charge = {
  /** Base, excluding tax. */
  amountPaise: number;
  taxPaise: number;
  /** What Razorpay is asked to collect. */
  totalPaise: number;
  gstPercent: number;
};

/**
 * Splits a price into base and tax.
 *
 * The subscription's stored `pricePaise` is treated as tax-exclusive: it is the
 * figure the hospital agreed to, and GST is a pass-through the government sets,
 * not part of the commercial agreement. Treating it as inclusive would silently
 * cut revenue by 15.3% the day registration completes.
 *
 * Rounded half-up to whole paise. Razorpay rejects fractional minor units, and
 * a consistent rule means the total on an invoice always equals its lines.
 */
export function computeCharge(basePaise: number, withGst = gstEnabled()): Charge {
  if (!Number.isInteger(basePaise) || basePaise <= 0) {
    throw new Error(`Charge base must be a positive integer in paise, got ${basePaise}`);
  }

  const taxPaise = withGst ? Math.round((basePaise * GST_PERCENT) / 100) : 0;

  return {
    amountPaise: basePaise,
    taxPaise,
    totalPaise: basePaise + taxPaise,
    gstPercent: withGst ? GST_PERCENT : 0,
  };
}

/** Money for humans. Paise are an implementation detail of storage. */
export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * The line a hospital owner reads on Razorpay's payment page.
 *
 * Names the hospital, the plan and the period being bought, because a bank
 * statement six weeks later is the wrong place to be working out what a
 * payment was for.
 */
export function renewalDescription(args: {
  hospitalName: string;
  planName: string;
  billingCycle: 'monthly' | 'annual';
  periodStart: Date;
  timezone: string;
}): string {
  const month = new Intl.DateTimeFormat('en-IN', {
    timeZone: args.timezone,
    month: 'short',
    year: 'numeric',
  }).format(args.periodStart);

  const term = args.billingCycle === 'annual' ? '12 months' : '1 month';
  return `${args.planName} plan · ${term} from ${month} · ${args.hospitalName}`;
}

/**
 * Razorpay caps `reference_id` at 40 characters. A UUID is 36, so a payment id
 * fits as-is — asserted rather than assumed, because silently truncating it
 * would break the webhook's ability to find the row it refers to.
 */
export const REFERENCE_ID_MAX = 40;

export function assertReferenceIdFits(reference: string): string {
  if (reference.length > REFERENCE_ID_MAX) {
    throw new Error(
      `Payment reference '${reference}' exceeds Razorpay's ${REFERENCE_ID_MAX}-character limit`,
    );
  }
  return reference;
}

/**
 * How long a payment link stays open.
 *
 * Razorpay requires at least 15 minutes. Seven days is long enough for an owner
 * to forward it to whoever holds the card, and short enough that a stale link
 * for last quarter's price cannot be paid months later.
 */
export const LINK_VALIDITY_DAYS = 7;

export function linkExpiryEpochSeconds(now: Date = new Date()): number {
  return Math.floor((now.getTime() + LINK_VALIDITY_DAYS * 86_400_000) / 1000);
}
