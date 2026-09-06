/**
 * Money is handled in paise as integers throughout. Never floats.
 *
 * Plans are priced per completed appointment because that is also what drives
 * cost (WhatsApp messages), which keeps contribution margin flat across
 * customer sizes. Doctors and branches are unlimited configuration, not levers.
 *
 * These constants are a seed for the `plan_tiers` table only. Production code
 * must read tiers from the database so pricing changes need no deploy.
 */
export type PlanTier = {
  code: string;
  name: string;
  /** Nameplate outpatients per day this tier is sold against. */
  patientsPerDay: number;
  includedAppointments: number;
  /**
   * The point at which message volume itself becomes billable.
   *
   * Set at 4.0 messages per included appointment — well past the 3.0 budget and
   * the 3.5 alert. A high ratio is nearly always a defect on our side rather
   * than something the hospital did, and billing a customer for our own
   * inefficiency is how you lose them. This exists only as a backstop against a
   * genuinely pathological tenant.
   */
  includedMessages: number;
  monthlyPricePaise: number;
  /** Ten months for twelve. Also waives the setup fee. */
  annualPricePaise: number;
  overagePaisePerAppointment: number;
  overagePaisePerMessage: number;
  setupFeePaise: number;
};

/**
 * One-time, per hospital. True cost is around ₹11,400 — mostly three days of
 * founder time across a discovery visit, configuration and on-site training.
 * Charging ₹5,000 recovers the hard costs and part of the time, and filters
 * buyers: a hospital unwilling to pay ₹5,000 to set up will not pay ₹7,000 a
 * month for a year.
 */
export const SETUP_FEE_PAISE = 500_000;

/**
 * Working days in a billing month. Indian OPDs typically run six days a week.
 */
export const WORKING_DAYS_PER_MONTH = 26;

/**
 * Headroom multiplier on every quota.
 *
 * A tier sized exactly at its nameplate rate breaches on an ordinary busy month:
 * 200/day × 26 days is 5,200, but a 27-day month at 215/day is 5,805. The
 * previous tier table included 5,500 for that hospital — six percent of room —
 * and would have generated an upgrade conversation with a customer who had done
 * nothing unusual.
 *
 * 1.35 absorbs a monsoon spike, a longer month, or a competing hospital closing.
 * Headroom is free unless consumed, because cost is variable per appointment.
 */
export const QUOTA_HEADROOM = 1.35;

const tier = (
  code: string,
  name: string,
  patientsPerDay: number,
  includedAppointments: number,
  monthlyRupees: number,
): PlanTier => ({
  code,
  name,
  patientsPerDay,
  includedAppointments,
  includedMessages: Math.round(includedAppointments * 4.0),
  monthlyPricePaise: monthlyRupees * 100,
  annualPricePaise: monthlyRupees * 10 * 100,
  // Marginal cost of an appointment is about ₹0.44 at the message budget, so
  // ₹1 is deliberately profitable: overage should nudge a hospital onto the
  // right tier rather than become a comfortable place to sit.
  overagePaisePerAppointment: 100,
  overagePaisePerMessage: 25,
  setupFeePaise: SETUP_FEE_PAISE,
});

/**
 * Quotas follow patientsPerDay × 26 × 1.35, rounded to something a human can
 * read. Prices are not a formula — the entry tier is set by fixed per-hospital
 * costs rather than by messages. At solo volumes the SIM, support and
 * infrastructure allocation come to about ₹650 against roughly ₹283 of
 * messages, which is why this range cannot start at ₹1,499.
 */
export const SEED_PLAN_TIERS: readonly PlanTier[] = [
  tier('solo', 'Solo', 25, 900, 1_999),
  tier('clinic', 'Clinic', 60, 2_100, 3_499),
  tier('practice', 'Practice', 100, 3_500, 4_999),
  tier('hospital', 'Hospital', 150, 5_300, 6_999),
  tier('large_opd', 'Large OPD', 200, 7_000, 8_999),
  tier('multi_branch', 'Multi-branch', 300, 10_500, 12_999),
] as const;

export type Bill = {
  planCode: string;
  basePaise: number;
  includedAppointments: number;
  completedAppointments: number;
  overageAppointments: number;
  appointmentOveragePaise: number;
  includedMessages: number;
  messagesSent: number;
  overageMessages: number;
  messageOveragePaise: number;
  totalPaise: number;
};

/**
 * Deterministic and reproducible from database records, because it appears on
 * an invoice.
 *
 * Two overages, deliberately different in character. Appointments beyond the
 * quota bill at ₹1 each — a line a doctor can predict and understand, priced to
 * nudge them onto the right tier. Messages only bill past the tier's allowance
 * of four per included appointment, far above the 3.0 budget and 3.5 alert,
 * because an abnormal ratio is nearly always our defect rather than the
 * hospital's behaviour.
 *
 * Neither overage stops service. This is healthcare; a queue that goes dark
 * mid-morning over a billing threshold is not an acceptable failure mode.
 */
export function calculateMonthlyBill(args: {
  tier: PlanTier;
  completedAppointments: number;
  messagesSent?: number;
}): Bill {
  const { tier, completedAppointments } = args;
  const messagesSent = args.messagesSent ?? 0;

  const overageAppointments = Math.max(
    0,
    completedAppointments - tier.includedAppointments,
  );
  const appointmentOveragePaise =
    overageAppointments * tier.overagePaisePerAppointment;

  /**
   * Message overage is measured against the tier's own allowance, not against
   * what the hospital actually used in appointments. A hospital well under its
   * appointment quota has bought that headroom and should not be charged for
   * messages it was entitled to send.
   */
  const overageMessages = Math.max(0, messagesSent - tier.includedMessages);
  const messageOveragePaise = overageMessages * tier.overagePaisePerMessage;

  return {
    planCode: tier.code,
    basePaise: tier.monthlyPricePaise,
    includedAppointments: tier.includedAppointments,
    completedAppointments,
    overageAppointments,
    appointmentOveragePaise,
    includedMessages: tier.includedMessages,
    messagesSent,
    overageMessages,
    messageOveragePaise,
    totalPaise:
      tier.monthlyPricePaise + appointmentOveragePaise + messageOveragePaise,
  };
}

/**
 * The internal cost model behind the published prices.
 *
 * A planning figure, not an accounting record — the authoritative number is
 * whatever Meta actually invoiced, recorded in `provider_invoices` and
 * reconciled on the platform dashboard. This lives here so the pricing tests
 * can assert that every tier still earns money under stress, which turns the
 * margin claim into something CI enforces rather than a spreadsheet nobody
 * reopens.
 */
export type CostModel = {
  paisePerMessage: number;
  /** SIM rental for that hospital's dedicated WhatsApp sender number. */
  simRentalPaise: number;
  supportPaise: number;
  infrastructurePaise: number;
};

/**
 * Support cost rises with hospital size; everything else is flat. Note how
 * heavily the flat costs weigh on the smallest tier — that, not messages, is
 * what sets the floor price of the range.
 */
export const COST_MODEL: Record<string, CostModel> = {
  solo: { paisePerMessage: 14.5, simRentalPaise: 25_000, supportPaise: 30_000, infrastructurePaise: 10_000 },
  clinic: { paisePerMessage: 14.5, simRentalPaise: 25_000, supportPaise: 40_000, infrastructurePaise: 10_000 },
  practice: { paisePerMessage: 14.5, simRentalPaise: 25_000, supportPaise: 50_000, infrastructurePaise: 10_000 },
  hospital: { paisePerMessage: 14.5, simRentalPaise: 25_000, supportPaise: 60_000, infrastructurePaise: 10_000 },
  large_opd: { paisePerMessage: 14.5, simRentalPaise: 25_000, supportPaise: 70_000, infrastructurePaise: 10_000 },
  multi_branch: { paisePerMessage: 14.5, simRentalPaise: 25_000, supportPaise: 90_000, infrastructurePaise: 10_000 },
};

/** What one hospital costs us in a month, in paise. */
export function monthlyCostPaise(args: {
  tier: PlanTier;
  appointments: number;
  messagesPerAppointment: number;
}): number {
  const cost = COST_MODEL[args.tier.code];
  if (!cost) throw new Error(`No cost model for tier ${args.tier.code}`);

  return (
    args.appointments * args.messagesPerAppointment * cost.paisePerMessage +
    cost.simRentalPaise +
    cost.supportPaise +
    cost.infrastructurePaise
  );
}

/** Contribution margin as a fraction, for a given usage scenario. */
export function contributionMargin(args: {
  tier: PlanTier;
  appointments: number;
  messagesPerAppointment: number;
}): number {
  const revenue = args.tier.monthlyPricePaise;
  return (revenue - monthlyCostPaise(args)) / revenue;
}

/** Expected monthly volume for a tier at its nameplate rate. */
export const nameplateAppointments = (tier: PlanTier): number =>
  tier.patientsPerDay * WORKING_DAYS_PER_MONTH;

/** Smallest tier that covers this volume; null means an Enterprise conversation. */
export function recommendTier(
  completedAppointments: number,
  tiers: readonly PlanTier[] = SEED_PLAN_TIERS,
): PlanTier | null {
  return (
    [...tiers]
      .sort((a, b) => a.includedAppointments - b.includedAppointments)
      .find((tier) => tier.includedAppointments >= completedAppointments) ?? null
  );
}

/**
 * The margin canary. Outbound WhatsApp messages per completed appointment is
 * the single number that governs this business, so it gets first-class
 * treatment in the domain layer rather than living in a dashboard query.
 */
export const MESSAGE_RATIO_BUDGET = 3.0;
export const MESSAGE_RATIO_ALERT = 3.5;
export const MESSAGE_RATIO_BREACH = 6.0;

export type RatioStatus = 'unknown' | 'ok' | 'alert' | 'breach';

/** Null when there is nothing to divide by; the caller decides what that means. */
export function messageRatio(args: {
  messagesSent: number;
  completedAppointments: number;
}): number | null {
  if (args.completedAppointments <= 0) return null;
  return args.messagesSent / args.completedAppointments;
}

export function ratioStatus(ratio: number | null): RatioStatus {
  if (ratio === null) return 'unknown';
  if (ratio >= MESSAGE_RATIO_BREACH) return 'breach';
  if (ratio >= MESSAGE_RATIO_ALERT) return 'alert';
  return 'ok';
}

/**
 * Circuit breaker against a runaway notification loop. Suppresses milestone
 * nudges only — booking confirmations are never suppressed, because a patient
 * who does not know their token is a patient we have actively harmed.
 */
export const shouldSuppressNonCriticalMessages = (ratio: number | null): boolean =>
  ratioStatus(ratio) === 'breach';
