import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ClearanceGateError,
  computeClearanceStatus,
} from '@/lib/services/ipd-clearance';
import type { IpdDischargeClearanceRow } from '@/lib/db/schema';

describe('ipd-clearance domain logic', () => {
  it('computes clearance status correctly when all departments are cleared', () => {
    const clearance: Partial<IpdDischargeClearanceRow> = {
      clinicalFitAt: new Date(),
      pharmacyReturnedAt: new Date(),
      nursingClearedAt: new Date(),
      ivCannulaRemoved: true,
      belongingsAndReportsHandedOver: true,
      billingClearedAt: new Date(),
      gatePassNumber: null,
    };

    const status = computeClearanceStatus({
      clearance: clearance as IpdDischargeClearanceRow,
      isSummaryFinalized: true,
      isBillingSettled: true,
    });

    expect(status.isMedicalCleared).toBe(true);
    expect(status.isPharmacyCleared).toBe(true);
    expect(status.isNursingCleared).toBe(true);
    expect(status.isSummaryFinalized).toBe(true);
    expect(status.isBillingCleared).toBe(true);
    expect(status.canIssueGatePass).toBe(true);
    expect(status.completedCount).toBe(5);
  });

  it('blocks gate pass issuance when nursing lines or pharmacy returns are pending', () => {
    const clearance: Partial<IpdDischargeClearanceRow> = {
      clinicalFitAt: new Date(),
      pharmacyReturnedAt: null, // Pending pharmacy return!
      nursingClearedAt: new Date(),
      ivCannulaRemoved: false, // Cannula still in place!
      belongingsAndReportsHandedOver: true,
      billingClearedAt: new Date(),
      gatePassNumber: null,
    };

    const status = computeClearanceStatus({
      clearance: clearance as IpdDischargeClearanceRow,
      isSummaryFinalized: true,
      isBillingSettled: true,
    });

    expect(status.isPharmacyCleared).toBe(false);
    expect(status.isNursingCleared).toBe(false);
    expect(status.canIssueGatePass).toBe(false);
    expect(status.completedCount).toBe(3);
  });

  it('ClearanceGateError captures the missing department reason', () => {
    const err = new ClearanceGateError('Cannot issue gate pass: Nursing lines not removed');
    expect(err.name).toBe('ClearanceGateError');
    expect(err.message).toContain('Nursing lines not removed');
  });
});
