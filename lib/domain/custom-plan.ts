import {
  MESSAGE_RATIO_BUDGET,
  QUOTA_HEADROOM,
  SETUP_FEE_PAISE,
  WORKING_DAYS_PER_MONTH,
} from './pricing';

/**
 * Pricing a bespoke plan for a hospital the published ladder does not fit.
 *
 * The top published tier is sold at 300 patients a day. Above that the flat
 * costs stop dominating and messaging becomes the whole cost base, so the
 * ladder's shape stops being informative and a quote has to be built rather
 * than looked up.
 *
 * Everything here is pure and every number is derived from an input you can
 * point at in a meeting. That is the point: a bespoke price argued from a
 * spreadsheet nobody can reproduce is how a founding-customer rate quietly
 * becomes a loss-making one two repricings later.
 */

/* ------------------------------------------------------------------ input */

export type CustomPlanInput = {
  /** Outpatients a day across every branch, at the volume being sold. */
  patientsPerDay: number;
  branches: number;
  doctors: number;
  staffLogins: number;
  /**
   * Messages per completed appointment. Defaults to the product's budget
   * rather than to what a hospital currently uses — a quote built on today's
   * ratio bakes in whatever defect is inflating it.
   */
  messagesPerAppointment?: number;
  /**
   * Real cost per message, from the latest provider invoice where one exists.
   * Passing the estimate is fine; passing nothing is not, because the number
   * that decides the floor should never be silently assumed.
   */
  paisePerMessage: number;
  /** Fraction, e.g. 0.65 for a 65% target contribution margin. */
  targetMargin: number;
  billingCycle: 'monthly' | 'annual';
};

/** Flat monthly costs that do not scale with volume, in paise. */
export type FixedCosts = {
  /** One dedicated sender number per branch, not per hospital. */
  simRentalPaisePerBranch: number;
  /** Rises with size; a 40-doctor account is not a 4-doctor account to support. */
  supportBasePaise: number;
  supportPaisePerDoctor: number;
  infrastructurePaise: number;
};

/**
 * Extrapolated from `COST_MODEL`, which stops at the multi_branch tier.
 *
 * Support there runs ₹300 at 1 doctor to ₹900 at 12, so roughly ₹250 fixed
 * plus ₹55 a doctor. Stated as a formula rather than another hard-coded rung
 * because the whole point of a custom plan is that it sits off the ladder.
 */
export const CUSTOM_FIXED_COSTS: FixedCosts = {
  simRentalPaisePerBranch: 25_000,
  supportBasePaise: 25_000,
  supportPaisePerDoctor: 5_500,
  infrastructurePaise: 10_000,
};

/* ----------------------------------------------------------------- output */

export type CustomPlanQuote = {
  /** Appointments a month at the sold volume. */
  monthlyAppointments: number;
  /** The allowance written on the plan, with headroom above nameplate. */
  includedAppointments: number;
  includedMessages: number;

  messagingCostPaise: number;
  fixedCostPaise: number;
  totalCostPaise: number;

  /** The price at which contribution margin equals the target. */
  suggestedMonthlyPaise: number;
  /** The price below which the account loses money every month. */
  breakevenMonthlyPaise: number;
  /** Ten months for twelve, matching the published cycle discount. */
  suggestedAnnualPaise: number;
  setupFeePaise: number;
};

const roundUpTo = (value: number, step: number): number => Math.ceil(value / step) * step;

/**
 * Builds a quote from volume and cost.
 *
 * The suggested price is rounded up to the nearest ₹500 because a bespoke
 * quote of ₹18,347 invites a negotiation about the ₹347 rather than about the
 * value, and because every published tier already ends in a round number.
 */
export function quoteCustomPlan(input: CustomPlanInput): CustomPlanQuote {
  const ratio = input.messagesPerAppointment ?? MESSAGE_RATIO_BUDGET;

  const monthlyAppointments = Math.round(input.patientsPerDay * WORKING_DAYS_PER_MONTH);

  /**
   * The allowance sits above expected volume by the same headroom the
   * published tiers use, so a normal busy month does not generate an overage
   * line. Overage is meant to catch a step change in usage, not to tax a
   * Tuesday.
   */
  const includedAppointments = Math.ceil(monthlyAppointments * QUOTA_HEADROOM);

  /**
   * Message allowance is set against the *allowance*, not expected volume, and
   * at a ratio well above the budget — for the same reason the published tiers
   * do it: a high ratio is nearly always our defect, and billing a hospital for
   * our inefficiency is how you lose them.
   */
  const includedMessages = Math.ceil(includedAppointments * (MESSAGE_RATIO_BUDGET + 1));

  const messagingCostPaise = Math.round(monthlyAppointments * ratio * input.paisePerMessage);

  const fixedCostPaise =
    input.branches * CUSTOM_FIXED_COSTS.simRentalPaisePerBranch +
    CUSTOM_FIXED_COSTS.supportBasePaise +
    input.doctors * CUSTOM_FIXED_COSTS.supportPaisePerDoctor +
    CUSTOM_FIXED_COSTS.infrastructurePaise;

  const totalCostPaise = messagingCostPaise + fixedCostPaise;

  /**
   * Clamped below 1: a 100% target margin implies an infinite price, and a
   * fat-fingered 1.0 in a form should produce a sane number rather than
   * Infinity rendered as "₹NaN".
   */
  const margin = Math.min(0.95, Math.max(0, input.targetMargin));
  const suggestedMonthlyPaise = roundUpTo(totalCostPaise / (1 - margin), 50_000);

  return {
    monthlyAppointments,
    includedAppointments,
    includedMessages,
    messagingCostPaise,
    fixedCostPaise,
    totalCostPaise,
    suggestedMonthlyPaise,
    breakevenMonthlyPaise: totalCostPaise,
    // Ten months for twelve, matching the published annual discount.
    suggestedAnnualPaise: roundUpTo(suggestedMonthlyPaise * 10, 50_000),
    setupFeePaise: input.billingCycle === 'annual' ? 0 : SETUP_FEE_PAISE,
  };
}

/* ------------------------------------------------------------ evaluation */

export type PriceVerdict =
  | { level: 'loss'; marginPercent: number; message: string }
  | { level: 'thin'; marginPercent: number; message: string }
  | { level: 'healthy'; marginPercent: number; message: string };

export const THIN_MARGIN = 0.4;

/**
 * What a chosen price actually means, given the costs.
 *
 * Returned rather than enforced. A strategic rate for a flagship account is a
 * legitimate decision; making it silently is not, so this exists to put the
 * number in front of whoever is typing the price.
 */
export function judgePrice(args: {
  monthlyPricePaise: number;
  quote: CustomPlanQuote;
}): PriceVerdict {
  const { totalCostPaise } = args.quote;

  if (args.monthlyPricePaise <= 0) {
    return {
      level: 'loss',
      marginPercent: -100,
      message: 'A price of zero costs us the full running cost every month.',
    };
  }

  const marginPercent =
    ((args.monthlyPricePaise - totalCostPaise) / args.monthlyPricePaise) * 100;

  if (args.monthlyPricePaise < totalCostPaise) {
    return {
      level: 'loss',
      marginPercent,
      message: `Below breakeven — this account loses ₹${Math.round(
        (totalCostPaise - args.monthlyPricePaise) / 100,
      ).toLocaleString('en-IN')} a month at the expected volume.`,
    };
  }

  if (marginPercent < THIN_MARGIN * 100) {
    return {
      level: 'thin',
      marginPercent,
      message:
        'Above breakeven but thin. One bad month on the message ratio wipes this out.',
    };
  }

  return {
    level: 'healthy',
    marginPercent,
    message: 'Comfortable contribution at the expected volume.',
  };
}

/**
 * Whether a custom plan undercuts the published ladder for the same volume.
 *
 * The failure this prevents is quiet and expensive: quoting a large hospital
 * below what a smaller one already pays on a standard tier, which is
 * indefensible the moment the two compare notes.
 */
export type PlanTierLike = {
  name: string;
  patientsPerDay: number;
  monthlyPricePaise: number;
};

export function undercutsLadder<T extends PlanTierLike>(args: {
  monthlyPricePaise: number;
  patientsPerDay: number;
  tiers: readonly T[];
}): T | null {
  const cheaper = args.tiers
    .filter((tier) => tier.patientsPerDay <= args.patientsPerDay)
    .filter((tier) => tier.monthlyPricePaise > args.monthlyPricePaise)
    // The most expensive tier that is both smaller and dearer is the sharpest
    // version of the comparison, and the one a customer would actually notice.
    .sort((a, b) => b.monthlyPricePaise - a.monthlyPricePaise);

  return cheaper[0] ?? null;
}

/**
 * A stable, readable code for the new tier.
 *
 * Prefixed so custom plans are obvious in `plan_tiers`, in a subscription row
 * and on an invoice, and suffixed with the hospital slug so two bespoke plans
 * never collide.
 */
export function customTierCode(hospitalSlug: string): string {
  const slug = hospitalSlug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/(^_|_$)/g, '')
    .slice(0, 40);
  return `custom_${slug || 'plan'}`;
}
