import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertReferenceIdFits,
  computeCharge,
  formatRupees,
  GST_PERCENT,
  gstEnabled,
  linkExpiryEpochSeconds,
  LINK_VALIDITY_DAYS,
  REFERENCE_ID_MAX,
  renewalDescription,
} from '../billing';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.BILLING_GST_ENABLED;
  delete process.env.BILLING_GST_ENABLED;
});
afterEach(() => {
  if (saved === undefined) delete process.env.BILLING_GST_ENABLED;
  else process.env.BILLING_GST_ENABLED = saved;
});

describe('computeCharge', () => {
  it('charges the bare price before GST registration', () => {
    const charge = computeCharge(199_900, false);
    expect(charge.amountPaise).toBe(199_900);
    expect(charge.taxPaise).toBe(0);
    expect(charge.totalPaise).toBe(199_900);
    expect(charge.gstPercent).toBe(0);
  });

  it('adds GST on top rather than carving it out', () => {
    /**
     * The direction matters commercially. The stored price is what the hospital
     * agreed to pay; treating it as tax-inclusive would silently cut revenue by
     * 15.3% on the day registration completes.
     */
    const charge = computeCharge(199_900, true);
    expect(charge.amountPaise).toBe(199_900);
    expect(charge.taxPaise).toBe(35_982);
    expect(charge.totalPaise).toBe(235_882);
  });

  it('keeps total equal to the sum of its lines', () => {
    // An invoice whose total disagrees with its lines is not an invoice.
    for (const base of [1, 99, 100, 199_900, 1_299_900, 33_333]) {
      const charge = computeCharge(base, true);
      expect(charge.amountPaise + charge.taxPaise).toBe(charge.totalPaise);
      expect(Number.isInteger(charge.taxPaise)).toBe(true);
    }
  });

  it('rounds tax to whole paise, because Razorpay rejects fractions', () => {
    // 33,333 × 18% = 5,999.94
    expect(computeCharge(33_333, true).taxPaise).toBe(6_000);
  });

  it('refuses a non-positive or fractional base', () => {
    expect(() => computeCharge(0, true)).toThrow();
    expect(() => computeCharge(-100, true)).toThrow();
    expect(() => computeCharge(100.5, true)).toThrow();
  });

  it('reads the flag from the environment by default', () => {
    expect(gstEnabled()).toBe(false);
    expect(computeCharge(100_000).taxPaise).toBe(0);

    process.env.BILLING_GST_ENABLED = 'true';
    expect(gstEnabled()).toBe(true);
    expect(computeCharge(100_000).taxPaise).toBe(GST_PERCENT * 1000);
  });

  it('treats anything other than the literal "true" as off', () => {
    // A half-configured flag must fail to the safe side: charging tax without
    // a GSTIN to remit it against is a compliance problem, not a rounding one.
    for (const value of ['1', 'yes', 'TRUE', '']) {
      process.env.BILLING_GST_ENABLED = value;
      expect(gstEnabled()).toBe(false);
    }
  });
});

describe('formatRupees', () => {
  it('always shows two decimal places', () => {
    expect(formatRupees(199_900)).toBe('₹1,999.00');
    expect(formatRupees(235_882)).toBe('₹2,358.82');
    expect(formatRupees(100)).toBe('₹1.00');
  });
});

describe('assertReferenceIdFits', () => {
  it('accepts a UUID, which is what a payment id is', () => {
    const uuid = crypto.randomUUID();
    expect(uuid.length).toBeLessThanOrEqual(REFERENCE_ID_MAX);
    expect(assertReferenceIdFits(uuid)).toBe(uuid);
  });

  it('throws rather than silently truncating', () => {
    // A truncated reference is one the webhook cannot resolve back to a row,
    // which means a real payment that can never be attributed.
    expect(() => assertReferenceIdFits('x'.repeat(41))).toThrow(/exceeds/);
  });
});

describe('linkExpiryEpochSeconds', () => {
  it('is the configured number of days out, in seconds', () => {
    const now = new Date('2026-09-20T10:00:00Z');
    const expiry = linkExpiryEpochSeconds(now);
    const expected = Math.floor(
      (now.getTime() + LINK_VALIDITY_DAYS * 86_400_000) / 1000,
    );
    expect(expiry).toBe(expected);
    expect(Number.isInteger(expiry)).toBe(true);
  });

  it('comfortably exceeds the 15-minute minimum Razorpay requires', () => {
    const now = new Date();
    expect(linkExpiryEpochSeconds(now) * 1000 - now.getTime()).toBeGreaterThan(
      16 * 60 * 1000,
    );
  });
});

describe('renewalDescription', () => {
  it('names the hospital, plan and term', () => {
    const text = renewalDescription({
      hospitalName: 'Sunrise Hospital',
      planName: 'Practice',
      billingCycle: 'monthly',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      timezone: 'Asia/Kolkata',
    });

    expect(text).toContain('Sunrise Hospital');
    expect(text).toContain('Practice');
    expect(text).toContain('1 month');
    expect(text).toContain('Oct 2026');
  });

  it('describes an annual term as twelve months', () => {
    const text = renewalDescription({
      hospitalName: 'H',
      planName: 'Hospital',
      billingCycle: 'annual',
      periodStart: new Date('2026-10-01T00:00:00Z'),
      timezone: 'Asia/Kolkata',
    });
    expect(text).toContain('12 months');
  });

  it('fits inside Razorpay\'s 2048-character description limit', () => {
    const text = renewalDescription({
      hospitalName: 'X'.repeat(200),
      planName: 'Y'.repeat(50),
      billingCycle: 'monthly',
      periodStart: new Date(),
      timezone: 'Asia/Kolkata',
    });
    expect(text.length).toBeLessThan(2048);
  });
});
