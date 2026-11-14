import { describe, it, expect } from 'vitest';
import { hasFeature, type Entitlements } from './entitlements';

describe('Inhouse Pharmacy Entitlement', () => {
  const baseEntitlements: Entitlements = {
    maxBranches: 1,
    maxDoctors: 2,
    maxStaffLogins: 5,
    hasDisplayBoard: true,
    hasOwnerReport: true,
    hasAdvancedReports: false,
    hasDataExport: false,
    hasAuditLog: false,
    hasInhousePharmacy: false,
    supportTier: 'email',
  };

  it('correctly reports inhouse_pharmacy false when disabled', () => {
    expect(hasFeature(baseEntitlements, 'inhouse_pharmacy')).toBe(false);
  });

  it('correctly reports inhouse_pharmacy true when enabled', () => {
    expect(
      hasFeature(
        { ...baseEntitlements, hasInhousePharmacy: true },
        'inhouse_pharmacy'
      )
    ).toBe(true);
  });
});
