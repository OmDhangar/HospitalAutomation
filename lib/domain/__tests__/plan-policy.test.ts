import { describe, expect, it } from 'vitest';
import { PlanAccess, addDays } from '../subscription';
import {
  FeatureDecision,
  PlanFeature,
  SAFE_HARBOR_FEATURES,
  getFeatureDecision,
} from '../plan-policy';

describe('plan-policy', () => {
  const now = new Date('2026-10-25T12:00:00.000Z');

  const openAccess: PlanAccess = {
    state: 'open',
    hasAssignedPlan: true,
    endsAt: addDays(now, 20),
  };

  const graceAccess: PlanAccess = {
    state: 'grace',
    hasAssignedPlan: true,
    endedAt: addDays(now, -3),
    locksAt: addDays(now, 4),
  };

  const softLockedAccess: PlanAccess = {
    state: 'soft_locked',
    hasAssignedPlan: true,
    reason: 'lapsed',
    endedAt: addDays(now, -8),
    locksAt: addDays(now, -1),
  };

  const revokedAccess: PlanAccess = {
    state: 'revoked',
    hasAssignedPlan: true,
    reason: 'suspended',
    endedAt: null,
  };

  const unassignedAccess: PlanAccess = {
    state: 'open',
    hasAssignedPlan: false,
    endsAt: null,
  };

  const fullEntitlements = {
    hasAdvancedReports: true,
    hasDataExport: true,
  };

  const basicEntitlements = {
    hasAdvancedReports: false,
    hasDataExport: false,
  };

  describe('SAFE_HARBOR_FEATURES', () => {
    it('contains all 8 clinical, billing, and operational features', () => {
      const expected: PlanFeature[] = [
        'clinical.opd',
        'clinical.ipd',
        'clinical.records',
        'operations.billing',
        'account.self',
        'subscription.view',
        'reports.history_view',
        'messaging.transactional',
      ];
      for (const feat of expected) {
        expect(SAFE_HARBOR_FEATURES.has(feat)).toBe(true);
      }
    });

    it('returns allow for all safe-harbor features across all states', () => {
      const states = [openAccess, graceAccess, softLockedAccess, revokedAccess, unassignedAccess];
      for (const access of states) {
        for (const feature of SAFE_HARBOR_FEATURES) {
          expect(getFeatureDecision({ access, feature })).toBe('allow');
        }
      }
    });
  });

  describe('subscription.renew', () => {
    it('allows renewal in open, grace, and soft_locked', () => {
      expect(getFeatureDecision({ access: openAccess, feature: 'subscription.renew' })).toBe('allow');
      expect(getFeatureDecision({ access: graceAccess, feature: 'subscription.renew' })).toBe('allow');
      expect(getFeatureDecision({ access: softLockedAccess, feature: 'subscription.renew' })).toBe('allow');
    });

    it('blocks self-serve renewal when administratively revoked', () => {
      expect(getFeatureDecision({ access: revokedAccess, feature: 'subscription.renew' })).toBe('blocked');
    });
  });

  describe('soft_locked and revoked feature gating', () => {
    const paidFeatures: PlanFeature[] = [
      'public.web_booking',
      'messaging.reminders',
      'messaging.campaigns',
      'reports.export',
      'reports.advanced',
      'hospital.staff_onboard',
    ];

    it('blocks paid growth features when soft_locked', () => {
      for (const feature of paidFeatures) {
        expect(getFeatureDecision({ access: softLockedAccess, feature })).toBe('blocked');
      }
    });

    it('blocks paid growth features when revoked', () => {
      for (const feature of paidFeatures) {
        expect(getFeatureDecision({ access: revokedAccess, feature })).toBe('blocked');
      }
    });
  });

  describe('unassigned onboarding hospitals', () => {
    it('blocks paid campaigns, online booking, and advanced reports for unassigned hospitals', () => {
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'messaging.campaigns' })).toBe('blocked');
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'reports.advanced' })).toBe('blocked');
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'reports.export' })).toBe('blocked');
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'public.web_booking' })).toBe('blocked');
    });

    it('still permits clinical safe harbor and staff onboarding for unassigned hospitals', () => {
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'clinical.opd' })).toBe('allow');
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'clinical.ipd' })).toBe('allow');
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'operations.billing' })).toBe('allow');
      expect(getFeatureDecision({ access: unassignedAccess, feature: 'hospital.staff_onboard' })).toBe('allow');
    });
  });

  describe('tier entitlements for active subscriptions', () => {
    it('allows tier-permitted features when plan includes them', () => {
      expect(
        getFeatureDecision({
          access: openAccess,
          tierEntitlements: fullEntitlements,
          feature: 'reports.advanced',
        }),
      ).toBe('allow');
      expect(
        getFeatureDecision({
          access: openAccess,
          tierEntitlements: fullEntitlements,
          feature: 'reports.export',
        }),
      ).toBe('allow');
    });

    it('blocks advanced reports when tier does not include them', () => {
      expect(
        getFeatureDecision({
          access: openAccess,
          tierEntitlements: basicEntitlements,
          feature: 'reports.advanced',
        }),
      ).toBe('blocked');
      expect(
        getFeatureDecision({
          access: openAccess,
          tierEntitlements: basicEntitlements,
          feature: 'reports.export',
        }),
      ).toBe('blocked');
    });

    it('permits standard paid features when tierEntitlements is omitted', () => {
      expect(getFeatureDecision({ access: openAccess, feature: 'public.web_booking' })).toBe('allow');
      expect(getFeatureDecision({ access: openAccess, feature: 'messaging.campaigns' })).toBe('allow');
      expect(getFeatureDecision({ access: openAccess, feature: 'messaging.reminders' })).toBe('allow');
      expect(getFeatureDecision({ access: openAccess, feature: 'hospital.staff_onboard' })).toBe('allow');
      expect(getFeatureDecision({ access: openAccess, feature: 'reports.advanced' })).toBe('blocked');
      expect(getFeatureDecision({ access: openAccess, feature: 'reports.export' })).toBe('blocked');
    });
  });
});
