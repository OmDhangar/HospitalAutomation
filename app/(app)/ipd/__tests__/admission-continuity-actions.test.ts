import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireWritableSession: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: 'doc-123' }]),
        }),
      }),
    };
    return fn(tx);
  }),
}));

vi.mock('@/lib/services/ipd-admission-continuity', () => ({
  approveDraftMedicationOrder: vi.fn(),
  approveAllDraftOrders: vi.fn(),
  rejectDraftOrder: vi.fn(),
  AdmissionContinuityError: class AdmissionContinuityError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'AdmissionContinuityError';
    }
  },
}));

import { requireWritableSession } from '@/lib/auth/session';
import {
  approveDraftMedicationOrder,
  approveAllDraftOrders,
  rejectDraftOrder,
} from '@/lib/services/ipd-admission-continuity';
import {
  approveDraftMedicationOrderAction,
  approveAllDraftMedicationOrdersAction,
  rejectDraftMedicationOrderAction,
} from '@/app/(app)/ipd/actions';
import { revalidatePath } from 'next/cache';

describe('admission continuity server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('RBAC authorization', () => {
    it('rejects unauthorized roles (receptionist) from approving draft order', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'user-recep',
        role: 'receptionist',
        readOnly: false,
      } as any);

      const res = await approveDraftMedicationOrderAction({
        admissionId: 'adm-1',
        orderId: 'ord-1',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/permission|cannot/i);
      expect(approveDraftMedicationOrder).not.toHaveBeenCalled();
    });

    it('rejects nurse from rejecting draft order', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'user-nurse',
        role: 'nurse',
        readOnly: false,
      } as any);

      const res = await rejectDraftMedicationOrderAction({
        admissionId: 'adm-1',
        orderId: 'ord-1',
        reason: 'Duplicate clinical order',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/permission|cannot/i);
      expect(rejectDraftOrder).not.toHaveBeenCalled();
    });
  });

  describe('approveDraftMedicationOrderAction', () => {
    it('allows authorized doctor to approve draft order and revalidates relevant paths', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'doc-user',
        role: 'doctor',
        readOnly: false,
      } as any);

      vi.mocked(approveDraftMedicationOrder).mockResolvedValueOnce(undefined);

      const res = await approveDraftMedicationOrderAction({
        admissionId: 'adm-1',
        orderId: 'ord-1',
        allergyOverrideReason: 'Benefit outweighs mild rash risk',
      });

      expect(res.ok).toBe(true);
      expect(approveDraftMedicationOrder).toHaveBeenCalledWith({
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        orderId: 'ord-1',
        doctorId: 'doc-123',
        actorUserId: 'doc-user',
        allergyOverrideReason: 'Benefit outweighs mild rash risk',
      });

      expect(revalidatePath).toHaveBeenCalledWith('/ipd/patients/adm-1/orders');
      expect(revalidatePath).toHaveBeenCalledWith('/ipd/patients/adm-1/summary');
      expect(revalidatePath).toHaveBeenCalledWith('/ipd/patients/adm-1/emar');
    });

    it('captures service errors gracefully and returns error message', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'doc-user',
        role: 'doctor',
        readOnly: false,
      } as any);

      vi.mocked(approveDraftMedicationOrder).mockRejectedValueOnce(
        new Error('Documented allergy conflict without override reason'),
      );

      const res = await approveDraftMedicationOrderAction({
        admissionId: 'adm-1',
        orderId: 'ord-1',
      });

      expect(res.ok).toBe(false);
      expect(res.error).toContain('Documented allergy conflict');
    });
  });

  describe('approveAllDraftMedicationOrdersAction', () => {
    it('allows authorized doctor to approve all draft orders', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'doc-user',
        role: 'doctor',
        readOnly: false,
      } as any);

      vi.mocked(approveAllDraftOrders).mockResolvedValueOnce({
        approvedCount: 3,
        errors: [],
      });

      const res = await approveAllDraftMedicationOrdersAction({
        admissionId: 'adm-1',
      });

      expect(res.ok).toBe(true);
      expect(res.approvedCount).toBe(3);
      expect(approveAllDraftOrders).toHaveBeenCalledWith({
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        doctorId: 'doc-123',
        actorUserId: 'doc-user',
        allergyOverrideReason: undefined,
      });

      expect(revalidatePath).toHaveBeenCalledWith('/ipd/patients/adm-1/orders');
      expect(revalidatePath).toHaveBeenCalledWith('/ipd/patients/adm-1/summary');
    });
  });

  describe('rejectDraftMedicationOrderAction', () => {
    it('allows doctor to reject draft order with reason', async () => {
      vi.mocked(requireWritableSession).mockResolvedValueOnce({
        hospitalId: 'hosp-1',
        userId: 'doc-user',
        role: 'doctor',
        readOnly: false,
      } as any);

      vi.mocked(rejectDraftOrder).mockResolvedValueOnce(undefined);

      const res = await rejectDraftMedicationOrderAction({
        admissionId: 'adm-1',
        orderId: 'ord-1',
        reason: 'Patient switched to IV formulation',
      });

      expect(res.ok).toBe(true);
      expect(rejectDraftOrder).toHaveBeenCalledWith({
        hospitalId: 'hosp-1',
        admissionId: 'adm-1',
        orderId: 'ord-1',
        reason: 'Patient switched to IV formulation',
        actorUserId: 'doc-user',
      });

      expect(revalidatePath).toHaveBeenCalledWith('/ipd/patients/adm-1/orders');
    });
  });
});
