/**
 * What a plan permits, as opposed to how much of it a hospital has used.
 *
 * Usage answers "how many appointments this month". Entitlement answers "may
 * this hospital add a fourth doctor at all". They move independently — a
 * hospital can be well inside its appointment allowance and still be at its
 * doctor limit — so they are separate modules rather than one blurred one.
 *
 * Everything here is pure. The rules are argued about in tests rather than
 * discovered when a receptionist cannot add a locum on a Monday morning.
 */

/** The countable axes. Each is a table that already exists. */
export type LimitKind = 'branches' | 'doctors' | 'staff';

/** The optional capabilities a tier can withhold. */
export type FeatureKind =
  | 'display_board'
  | 'owner_report'
  | 'advanced_reports'
  | 'data_export'
  | 'audit_log';

/**
 * The shape both `plan_tiers` and `subscriptions` satisfy.
 *
 * Deliberately structural rather than importing a table type: entitlement
 * questions are asked of the subscription in production, and of the rate card
 * on the pricing page, and neither should have to be converted into the other.
 */
export type Entitlements = {
  maxBranches: number | null;
  maxDoctors: number | null;
  maxStaffLogins: number | null;
  hasDisplayBoard: boolean;
  hasOwnerReport: boolean;
  hasAdvancedReports: boolean;
  hasDataExport: boolean;
  hasAuditLog: boolean;
  supportTier: string;
};

/** `null` is unlimited, which is a different statement from a large number. */
export function limitFor(entitlements: Entitlements, kind: LimitKind): number | null {
  switch (kind) {
    case 'branches':
      return entitlements.maxBranches;
    case 'doctors':
      return entitlements.maxDoctors;
    case 'staff':
      return entitlements.maxStaffLogins;
  }
}

export function hasFeature(entitlements: Entitlements, feature: FeatureKind): boolean {
  switch (feature) {
    case 'display_board':
      return entitlements.hasDisplayBoard;
    case 'owner_report':
      return entitlements.hasOwnerReport;
    case 'advanced_reports':
      return entitlements.hasAdvancedReports;
    case 'data_export':
      return entitlements.hasDataExport;
    case 'audit_log':
      return entitlements.hasAuditLog;
  }
}

export type LimitCheck =
  | { allowed: true }
  | { allowed: false; limit: number; current: number; kind: LimitKind };

/**
 * Whether one more of something may be added.
 *
 * Asked with the count that exists *now*, and answers about adding one more —
 * so a hospital at its limit is refused, and a hospital already over it is
 * refused too, without either being disturbed. Nothing here removes anything.
 *
 * A hospital can end up over its limit legitimately: a downgrade, or a limit
 * introduced after they were already set up. Deleting their fourth doctor
 * because the rate card changed would be indefensible, so existing rows are
 * always left alone and only the next addition is stopped. That is the whole
 * of the grandfathering rule, and it lives here so no caller can forget it.
 */
export function checkLimit(args: {
  entitlements: Entitlements;
  kind: LimitKind;
  current: number;
}): LimitCheck {
  const limit = limitFor(args.entitlements, args.kind);
  if (limit === null) return { allowed: true };
  if (args.current < limit) return { allowed: true };
  return { allowed: false, limit, current: args.current, kind: args.kind };
}

const NOUN: Record<LimitKind, { one: string; many: string }> = {
  branches: { one: 'branch', many: 'branches' },
  doctors: { one: 'doctor', many: 'doctors' },
  staff: { one: 'staff login', many: 'staff logins' },
};

/**
 * What the person who hit the limit is told.
 *
 * Names the number they have and the number they are entitled to, because
 * "upgrade your plan" without either is the kind of message that generates a
 * phone call to reception rather than an upgrade. The plan to move to is
 * supplied by the caller, which knows the rate card; this module does not.
 */
export function limitMessage(check: Extract<LimitCheck, { allowed: false }>, nextPlan?: {
  name: string;
  limit: number | null;
  monthlyPricePaise: number;
}): string {
  const noun = NOUN[check.kind];
  const have = `Your plan includes ${check.limit} ${check.limit === 1 ? noun.one : noun.many}`;

  if (!nextPlan) {
    return `${have}, and ${check.current} ${check.current === 1 ? 'is' : 'are'} already set up.`;
  }

  const allows =
    nextPlan.limit === null
      ? `unlimited ${noun.many}`
      : `${nextPlan.limit} ${nextPlan.limit === 1 ? noun.one : noun.many}`;
  const rupees = Math.round(nextPlan.monthlyPricePaise / 100).toLocaleString('en-IN');

  return `${have}. To add another, upgrade to ${nextPlan.name} — ${allows}, ₹${rupees}/month.`;
}

/** How support is described on the pricing page and in contracts. */
export const SUPPORT_TIER_LABEL: Record<string, string> = {
  email: 'Email support',
  email_48h: 'Email support, 48-hour response',
  email_24h: 'Email support, 24-hour response',
  whatsapp_12h: 'WhatsApp support, 12-hour response',
  whatsapp_4h: 'WhatsApp support, 4-hour response',
  priority_4h: 'Priority support, 4-hour response',
  dedicated: 'Dedicated account manager',
};

export const supportLabel = (tier: string): string =>
  SUPPORT_TIER_LABEL[tier] ?? SUPPORT_TIER_LABEL.email;
