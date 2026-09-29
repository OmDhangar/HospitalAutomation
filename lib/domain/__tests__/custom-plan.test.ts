import { describe, expect, it } from 'vitest';
import {
  CUSTOM_FIXED_COSTS,
  customTierCode,
  judgePrice,
  quoteCustomPlan,
  undercutsLadder,
  type CustomPlanInput,
} from '../custom-plan';
import {
  MESSAGE_RATIO_BUDGET,
  QUOTA_HEADROOM,
  SEED_PLAN_TIERS,
  SETUP_FEE_PAISE,
  WORKING_DAYS_PER_MONTH,
} from '../pricing';

const base: CustomPlanInput = {
  patientsPerDay: 500,
  branches: 4,
  doctors: 30,
  staffLogins: 40,
  paisePerMessage: 14.5,
  targetMargin: 0.65,
  billingCycle: 'monthly',
};

describe('quoteCustomPlan', () => {
  it('derives monthly volume from the working-day model', () => {
    expect(quoteCustomPlan(base).monthlyAppointments).toBe(500 * WORKING_DAYS_PER_MONTH);
  });

  /**
   * The allowance sits above expected volume by the same headroom the
   * published tiers use, so a normal busy month does not generate an overage
   * line. Overage catches a step change, not a Tuesday.
   */
  it('puts headroom above nameplate volume', () => {
    const quote = quoteCustomPlan(base);
    expect(quote.includedAppointments).toBe(
      Math.ceil(quote.monthlyAppointments * QUOTA_HEADROOM),
    );
    expect(quote.includedAppointments).toBeGreaterThan(quote.monthlyAppointments);
  });

  it('sets the message allowance above the ratio budget', () => {
    const quote = quoteCustomPlan(base);
    expect(quote.includedMessages).toBeGreaterThan(
      quote.includedAppointments * MESSAGE_RATIO_BUDGET,
    );
  });

  it('scales SIM rental per branch, not per hospital', () => {
    const one = quoteCustomPlan({ ...base, branches: 1 });
    const four = quoteCustomPlan({ ...base, branches: 4 });
    expect(four.fixedCostPaise - one.fixedCostPaise).toBe(
      3 * CUSTOM_FIXED_COSTS.simRentalPaisePerBranch,
    );
  });

  it('charges more support for more doctors', () => {
    const small = quoteCustomPlan({ ...base, doctors: 10 });
    const large = quoteCustomPlan({ ...base, doctors: 30 });
    expect(large.fixedCostPaise).toBeGreaterThan(small.fixedCostPaise);
  });

  /**
   * The cost that actually moves at this scale. Doubling the ratio should
   * roughly double the messaging cost, which is why the quote is built on the
   * budget rather than on whatever a hospital happens to be doing today.
   */
  it('tracks the message ratio', () => {
    const atBudget = quoteCustomPlan({ ...base, messagesPerAppointment: 3 });
    const atDouble = quoteCustomPlan({ ...base, messagesPerAppointment: 6 });
    expect(atDouble.messagingCostPaise).toBe(atBudget.messagingCostPaise * 2);
  });

  it('reaches the target margin at the suggested price', () => {
    const quote = quoteCustomPlan(base);
    const actual =
      (quote.suggestedMonthlyPaise - quote.totalCostPaise) / quote.suggestedMonthlyPaise;
    // At or above target — the price is rounded up, never down.
    expect(actual).toBeGreaterThanOrEqual(0.65);
  });

  it('rounds the suggestion to a negotiable number', () => {
    expect(quoteCustomPlan(base).suggestedMonthlyPaise % 50_000).toBe(0);
  });

  it('reports breakeven as the true monthly cost', () => {
    const quote = quoteCustomPlan(base);
    expect(quote.breakevenMonthlyPaise).toBe(quote.totalCostPaise);
    expect(quote.totalCostPaise).toBe(quote.messagingCostPaise + quote.fixedCostPaise);
  });

  it('waives the setup fee on annual, matching the published cycles', () => {
    expect(quoteCustomPlan({ ...base, billingCycle: 'annual' }).setupFeePaise).toBe(0);
    expect(quoteCustomPlan({ ...base, billingCycle: 'monthly' }).setupFeePaise).toBe(
      SETUP_FEE_PAISE,
    );
  });

  it('gives ten months for twelve on annual', () => {
    const quote = quoteCustomPlan(base);
    expect(quote.suggestedAnnualPaise).toBeLessThan(quote.suggestedMonthlyPaise * 12);
  });

  /**
   * A fat-fingered 1.0 in a margin field must not render as "₹NaN" or
   * Infinity. It clamps to something extreme but finite.
   */
  it('clamps an impossible target margin', () => {
    const quote = quoteCustomPlan({ ...base, targetMargin: 1 });
    expect(Number.isFinite(quote.suggestedMonthlyPaise)).toBe(true);
    expect(quote.suggestedMonthlyPaise).toBeGreaterThan(quote.totalCostPaise);
  });
});

describe('judgePrice', () => {
  const quote = quoteCustomPlan(base);

  it('calls a price below cost a loss, and says by how much', () => {
    const verdict = judgePrice({
      monthlyPricePaise: quote.totalCostPaise - 100_000,
      quote,
    });
    expect(verdict.level).toBe('loss');
    expect(verdict.message).toContain('Below breakeven');
  });

  it('flags a price that clears cost but leaves no room', () => {
    const verdict = judgePrice({
      monthlyPricePaise: Math.round(quote.totalCostPaise * 1.15),
      quote,
    });
    expect(verdict.level).toBe('thin');
  });

  it('is content at the suggested price', () => {
    const verdict = judgePrice({ monthlyPricePaise: quote.suggestedMonthlyPaise, quote });
    expect(verdict.level).toBe('healthy');
    expect(verdict.marginPercent).toBeGreaterThanOrEqual(65);
  });

  it('does not divide by zero on a free plan', () => {
    const verdict = judgePrice({ monthlyPricePaise: 0, quote });
    expect(verdict.level).toBe('loss');
    expect(Number.isFinite(verdict.marginPercent)).toBe(true);
  });
});

describe('undercutsLadder', () => {
  /**
   * The expensive, quiet mistake: quoting a large hospital below what a
   * smaller one already pays on a standard tier — indefensible the moment the
   * two compare notes.
   */
  it('catches a custom price beneath a smaller published tier', () => {
    const undercut = undercutsLadder({
      monthlyPricePaise: 300_000, // ₹3,000
      patientsPerDay: 500,
      tiers: SEED_PLAN_TIERS,
    });
    expect(undercut).not.toBeNull();
    expect(undercut!.monthlyPricePaise).toBeGreaterThan(300_000);
    expect(undercut!.patientsPerDay).toBeLessThanOrEqual(500);
  });

  it('is quiet when the custom price sits above the whole ladder', () => {
    expect(
      undercutsLadder({
        monthlyPricePaise: 5_000_000,
        patientsPerDay: 500,
        tiers: SEED_PLAN_TIERS,
      }),
    ).toBeNull();
  });

  it('ignores tiers sold at a larger volume than the quote', () => {
    // A 20-patient-a-day custom plan is not undercutting Multi-branch.
    expect(
      undercutsLadder({
        monthlyPricePaise: 100_000,
        patientsPerDay: 20,
        tiers: SEED_PLAN_TIERS,
      }),
    ).toBeNull();
  });
});

describe('customTierCode', () => {
  it('is prefixed so a bespoke plan is obvious on an invoice', () => {
    expect(customTierCode('apollo-pune')).toBe('custom_apollo_pune');
  });

  it('survives a slug that is all punctuation', () => {
    expect(customTierCode('---')).toBe('custom_plan');
  });

  it('bounds the length', () => {
    expect(customTierCode('a'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});
