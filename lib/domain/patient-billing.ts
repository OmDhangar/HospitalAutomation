/**
 * Patient billing arithmetic. Pure: no database, no React.
 *
 * Everything is integer paise, as in `billing.ts`. A rupee amount that went
 * through a float on its way to a bill is how ₹10.00 becomes ₹9.99.
 *
 * The server computes every amount here and stores the result on the bill
 * item. The UI only ever displays numbers that came back from the server, so
 * there is exactly one implementation of the maths and it is this one.
 */

/** Basis points: 1800 = 18%. Integer, so a tax rate is never 0.18000000000000002. */
export const MAX_TAX_RATE_BP = 10_000;

export type BillItemAmounts = {
  subtotalPaise: number;
  discountPaise: number;
  taxPaise: number;
  totalPaise: number;
};

export class BillingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BillingInputError';
  }
}

const assertWhole = (value: number, what: string, min: number) => {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new BillingInputError(`${what} must be a whole number of at least ${min}, got ${value}`);
  }
};

/**
 * One line: quantity × unit price, less discount, plus tax on what remains.
 *
 * Tax is charged on the discounted amount — a concession reduces the tax as
 * well as the price — and rounded half-up to whole paise, matching
 * `computeCharge` in billing.ts.
 */
export function calculateBillItem(args: {
  quantity: number;
  unitPricePaise: number;
  taxRateBp?: number;
  discountPaise?: number;
}): BillItemAmounts {
  const taxRateBp = args.taxRateBp ?? 0;
  const discountPaise = args.discountPaise ?? 0;

  assertWhole(args.quantity, 'Quantity', 1);
  assertWhole(args.unitPricePaise, 'Unit price', 0);
  assertWhole(discountPaise, 'Discount', 0);
  assertWhole(taxRateBp, 'Tax rate', 0);
  if (taxRateBp > MAX_TAX_RATE_BP) {
    throw new BillingInputError(`Tax rate cannot exceed 100%, got ${taxRateBp / 100}%`);
  }

  const subtotalPaise = args.quantity * args.unitPricePaise;
  if (!Number.isSafeInteger(subtotalPaise)) {
    throw new BillingInputError('Line amount is too large');
  }
  if (discountPaise > subtotalPaise) {
    throw new BillingInputError('Discount cannot be more than the line amount');
  }

  const taxablePaise = subtotalPaise - discountPaise;
  const taxPaise = Math.round((taxablePaise * taxRateBp) / MAX_TAX_RATE_BP);

  return {
    subtotalPaise,
    discountPaise,
    taxPaise,
    totalPaise: taxablePaise + taxPaise,
  };
}

/** Totals for a bill, from its live (not voided) items. */
export function sumBillItems(items: readonly BillItemAmounts[]): BillItemAmounts {
  return items.reduce<BillItemAmounts>(
    (sum, item) => ({
      subtotalPaise: sum.subtotalPaise + item.subtotalPaise,
      discountPaise: sum.discountPaise + item.discountPaise,
      taxPaise: sum.taxPaise + item.taxPaise,
      totalPaise: sum.totalPaise + item.totalPaise,
    }),
    { subtotalPaise: 0, discountPaise: 0, taxPaise: 0, totalPaise: 0 },
  );
}

export type PaymentStatus = 'unpaid' | 'partial' | 'paid';

/**
 * What the pill at the desk says.
 *
 * Nothing charged yet reads as unpaid: that is the state reception needs to
 * act on. Something charged and fully covered — including a ₹0 free
 * consultation — reads as paid.
 */
export function paymentStatus(args: {
  hasCharges: boolean;
  totalPaise: number;
  paidPaise: number;
}): PaymentStatus {
  if (!args.hasCharges) return 'unpaid';
  if (args.paidPaise >= args.totalPaise) return 'paid';
  if (args.paidPaise > 0) return 'partial';
  return 'unpaid';
}

/**
 * Parses what a person typed into a rupee box ("300", "300.5", "1,250.00")
 * into paise, without going through a float.
 *
 * Returns null for anything that is not a plain non-negative amount with at
 * most two decimals, so the caller can say "enter an amount like 300".
 */
export function parseRupeesToPaise(input: string): number | null {
  return parseTwoDecimals(input.replace(/₹/g, ''));
}

/**
 * A tax rate as typed ("12", "2.5", "18%") in basis points (1200, 250, 1800),
 * or null. Capped at 100%.
 */
export function parsePercentToBasisPoints(input: string): number | null {
  const bp = parseTwoDecimals(input.replace(/%/g, ''));
  return bp !== null && bp <= MAX_TAX_RATE_BP ? bp : null;
}

/** "1,250.5" → 125050: a non-negative decimal with at most two places, scaled by 100. */
function parseTwoDecimals(input: string): number | null {
  const cleaned = input.trim().replace(/[,\s]/g, '');
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return null;
  const whole = Number(match[1]);
  const hundredths = Number((match[2] ?? '').padEnd(2, '0'));
  return whole * 100 + hundredths;
}
