import { describe, expect, it } from 'vitest';
import { computeClearanceStatus } from '../discharge-clearance';

describe('computeClearanceStatus (domain)', () => {
  it('computes 0 completed when no clearances are recorded', () => {
    const status = computeClearanceStatus({
      clearance: null,
      isSummaryFinalized: false,
      isBillingSettled: false,
    });

    expect(status.completedCount).toBe(0);
    expect(status.canIssueGatePass).toBe(false);
    expect(status.isMedicalCleared).toBe(false);
    expect(status.isPharmacyCleared).toBe(false);
    expect(status.isNursingCleared).toBe(false);
    expect(status.isSummaryFinalized).toBe(false);
    expect(status.isBillingCleared).toBe(false);
  });

  it('allows gate pass when all 5 departments have cleared', () => {
    const now = new Date();
    const status = computeClearanceStatus({
      clearance: {
        clinicalFitAt: now,
        pharmacyReturnedAt: now,
        nursingClearedAt: now,
        ivCannulaRemoved: true,
        belongingsAndReportsHandedOver: true,
        billingClearedAt: now,
      },
      isSummaryFinalized: true,
      isBillingSettled: true,
    });

    expect(status.completedCount).toBe(5);
    expect(status.canIssueGatePass).toBe(true);
  });
});
