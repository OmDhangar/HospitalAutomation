import { describe, expect, it } from 'vitest';
import {
  AdmissionContinuityError,
  portOpdPrescriptionsToIpdDraftsInTx,
  listDraftOrders,
  approveDraftMedicationOrder,
  approveAllDraftOrders,
  rejectDraftOrder,
} from '@/lib/services/ipd-admission-continuity';

describe('ipd-admission-continuity service', () => {
  it('exports core continuity and lifecycle functions', () => {
    expect(typeof portOpdPrescriptionsToIpdDraftsInTx).toBe('function');
    expect(typeof listDraftOrders).toBe('function');
    expect(typeof approveDraftMedicationOrder).toBe('function');
    expect(typeof approveAllDraftOrders).toBe('function');
    expect(typeof rejectDraftOrder).toBe('function');
  });

  it('rejectDraftOrder throws AdmissionContinuityError when reason is under 3 characters', async () => {
    await expect(
      rejectDraftOrder({
        hospitalId: '00000000-0000-0000-0000-000000000001',
        admissionId: '00000000-0000-0000-0000-000000000002',
        orderId: '00000000-0000-0000-0000-000000000003',
        reason: 'no',
        actorUserId: '00000000-0000-0000-0000-000000000004',
      }),
    ).rejects.toThrow(AdmissionContinuityError);
  });

  it('AdmissionContinuityError has correct name and message', () => {
    const err = new AdmissionContinuityError('Test failure');
    expect(err.name).toBe('AdmissionContinuityError');
    expect(err.message).toBe('Test failure');
  });
});
