import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireWritableSession: vi.fn(),
}));

vi.mock('@/lib/services/ipd-clearance', () => ({
  updateMedicalClearance: vi.fn(),
  recordPharmacyClearance: vi.fn(),
  updateNursingClearance: vi.fn(),
  issueDischargeGatePass: vi.fn().mockResolvedValue({ gatePassNumber: 'GP-2026-1001', issuedAt: new Date() }),
  ClearanceGateError: class ClearanceGateError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'ClearanceGateError';
    }
  },
}));

import { requireWritableSession } from '@/lib/auth/session';
import {
  updateMedicalClearanceAction,
  recordPharmacyClearanceAction,
  updateNursingClearanceAction,
  issueDischargeGatePassAction,
} from '@/app/(app)/ipd/actions';

describe('clearance server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects unauthorized roles from updating medical clearance', async () => {
    vi.mocked(requireWritableSession).mockResolvedValueOnce({
      hospitalId: 'mock-hosp',
      userId: 'mock-user',
      role: 'receptionist',
      readOnly: false,
    } as any);

    const res = await updateMedicalClearanceAction({
      admissionId: 'adm-123',
      dischargeType: 'regular',
      ready: true,
    });

    expect(res.ok).toBe(false);
    expect(res.error).toContain('permission');
  });

  it('allows doctor to update medical clearance', async () => {
    vi.mocked(requireWritableSession).mockResolvedValueOnce({
      hospitalId: 'mock-hosp',
      userId: 'doc-user',
      role: 'doctor',
      readOnly: false,
    } as any);

    const res = await updateMedicalClearanceAction({
      admissionId: 'adm-123',
      dischargeType: 'regular',
      ready: true,
    });

    expect(res.ok).toBe(true);
  });

  it('allows nurse to update nursing clearance', async () => {
    vi.mocked(requireWritableSession).mockResolvedValueOnce({
      hospitalId: 'mock-hosp',
      userId: 'nurse-user',
      role: 'nurse',
      readOnly: false,
    } as any);

    const res = await updateNursingClearanceAction({
      admissionId: 'adm-123',
      ivCannulaRemoved: true,
      foleyCatheterRemoved: true,
      drainsRemoved: false,
      woundDressingDone: true,
      belongingsAndReportsHandedOver: true,
      dischargeVitalsTaken: true,
      cleared: true,
    });

    expect(res.ok).toBe(true);
  });
});
