import type { PlanAccess } from './subscription';

export type FeatureDecision = 'allow' | 'read_only' | 'blocked';

export type PlanFeature =
  // Safe Harbor (always allowed regardless of plan state)
  | 'clinical.opd'
  | 'clinical.ipd'
  | 'clinical.records'
  | 'operations.billing'
  | 'account.self'
  | 'subscription.view'
  | 'reports.history_view'
  | 'messaging.transactional'

  // Paid / Growth capabilities (governed by lifecycle & plan tier entitlements)
  | 'public.web_booking'
  | 'messaging.reminders'
  | 'messaging.campaigns'
  | 'reports.export'
  | 'reports.advanced'
  | 'hospital.staff_onboard'
  | 'subscription.renew';

export const SAFE_HARBOR_FEATURES = new Set<PlanFeature>([
  'clinical.opd',
  'clinical.ipd',
  'clinical.records',
  'operations.billing',
  'account.self',
  'subscription.view',
  'reports.history_view',
  'messaging.transactional',
]);

export type TierEntitlements = {
  hasAdvancedReports?: boolean;
  hasDataExport?: boolean;
  [key: string]: unknown;
};

/**
 * Evaluates whether a feature is permitted under the hospital's plan access state and tier entitlements.
 *
 * Evaluation order:
 * 1. Safe Harbor: essential clinical, billing, and operational messaging are ALWAYS allowed.
 * 2. Subscription renewal: available during open, grace & soft_locked; blocked if administratively revoked.
 * 3. Lifecycle lock: if soft-locked or revoked, paid growth features are paused.
 * 4. Unassigned onboarding hospital: only explicitly allowed onboarding capabilities.
 * 5. Tier Entitlements: active subscriptions only receive features included in their plan tier.
 */
export function getFeatureDecision(args: {
  access: PlanAccess;
  tierEntitlements?: TierEntitlements | null;
  feature: PlanFeature;
}): FeatureDecision {
  const { access, tierEntitlements, feature } = args;

  // 1. Safe Harbor features are never blocked
  if (SAFE_HARBOR_FEATURES.has(feature)) {
    return 'allow';
  }

  // 2. Subscription renewal
  if (feature === 'subscription.renew') {
    return access.state === 'revoked' ? 'blocked' : 'allow';
  }

  // 3. Lifecycle lock: soft_locked and revoked pause paid capabilities
  if (access.state === 'soft_locked' || access.state === 'revoked') {
    return 'blocked';
  }

  // 4. Unassigned onboarding hospital
  if (!access.hasAssignedPlan) {
    return isExplicitlyAllowedForOnboarding(feature) ? 'allow' : 'blocked';
  }

  // 5. Tier Entitlements
  return planIncludesFeature(tierEntitlements, feature) ? 'allow' : 'blocked';
}

function isExplicitlyAllowedForOnboarding(feature: PlanFeature): boolean {
  // During onboarding, hospital sets up its staff before activating a plan.
  if (feature === 'hospital.staff_onboard') return true;
  return false;
}

function planIncludesFeature(
  entitlements: TierEntitlements | null | undefined,
  feature: PlanFeature,
): boolean {
  if (entitlements) {
    if (feature === 'reports.advanced') return Boolean(entitlements.hasAdvancedReports);
    if (feature === 'reports.export') return Boolean(entitlements.hasDataExport);
  } else {
    if (feature === 'reports.advanced' || feature === 'reports.export') return false;
  }
  return true;
}
