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
  includedAppointments: number;
  monthlyPricePaise: number;
};

export const SEED_PLAN_TIERS: readonly PlanTier[] = [
  { code: 'clinic', name: 'Clinic', includedAppointments: 800, monthlyPricePaise: 149_900 },
  { code: 'small', name: 'Small', includedAppointments: 2_000, monthlyPricePaise: 299_900 },
  { code: 'standard', name: 'Standard', includedAppointments: 3_500, monthlyPricePaise: 499_900 },
  { code: 'large', name: 'Large', includedAppointments: 5_500, monthlyPricePaise: 699_900 },
  { code: 'multi_branch', name: 'Multi-branch', includedAppointments: 9_000, monthlyPricePaise: 1_099_900 },
] as const;

export type Bill = {
  planCode: string;
  basePaise: number;
  includedAppointments: number;
  completedAppointments: number;
  overageAppointments: number;
  overagePaise: number;
  totalPaise: number;
};

/**
 * Deterministic and reproducible from database records, because it appears on
 * an invoice. V1 leaves `overagePaisePerAppointment` at 0: quota is a soft cap
 * that triggers an upgrade conversation, never a surprise charge or a service
 * cut — this is healthcare.
 */
export function calculateMonthlyBill(args: {
  tier: PlanTier;
  completedAppointments: number;
  overagePaisePerAppointment?: number;
}): Bill {
  const { tier, completedAppointments } = args;
  const overagePaisePerAppointment = args.overagePaisePerAppointment ?? 0;

  const overageAppointments = Math.max(
    0,
    completedAppointments - tier.includedAppointments,
  );
  const overagePaise = overageAppointments * overagePaisePerAppointment;

  return {
    planCode: tier.code,
    basePaise: tier.monthlyPricePaise,
    includedAppointments: tier.includedAppointments,
    completedAppointments,
    overageAppointments,
    overagePaise,
    totalPaise: tier.monthlyPricePaise + overagePaise,
  };
}

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
