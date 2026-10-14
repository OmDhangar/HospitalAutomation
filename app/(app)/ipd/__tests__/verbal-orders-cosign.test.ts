import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  cosignVerbalOrderAction,
  rejectVerbalOrderAction,
} from '@/app/(app)/ipd/actions';

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSet = vi.fn();
const mockWhere = vi.fn();

let mockOrderRecord: any = null;
let currentSession = {
  userId: 'user-doc-1',
  role: 'doctor',
  hospitalId: 'hosp-1',
  branchId: 'branch-1',
};

vi.mock('@/lib/auth/session', () => ({
  requireWritableSession: vi.fn(() => Promise.resolve(currentSession)),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => {
            return Promise.resolve(mockOrderRecord ? [mockOrderRecord] : []);
          },
        }),
      }),
      update: () => ({
        set: (...args: any[]) => {
          mockSet(...args);
          return {
            where: (...wArgs: any[]) => {
              mockWhere(...wArgs);
              return Promise.resolve([{ id: 'order-verbal-1' }]);
            },
          };
        },
      }),
      insert: () => ({
        values: (val: any) => {
          mockInsert(val);
          return Promise.resolve([{ id: 'audit-1' }]);
        },
      }),
    };
    return fn(tx);
  }),
}));

describe('Explicit Verbal Orders Co-Sign & Rejection State Machine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrderRecord = {
      id: 'order-verbal-1',
      hospitalId: 'hosp-1',
      admissionId: 'adm-1',
      isVerbal: true,
      verbalOrderStatus: 'pending_cosign',
      status: 'active',
      doctorId: 'doc-1',
      medicineName: 'Inj Atropine 0.6mg',
    };
  });

  it('allows doctor to co-sign pending verbal order with timestamp and notes', async () => {
    const res = await cosignVerbalOrderAction({
      orderId: 'order-verbal-1',
      notes: 'Confirmed verbally ordered during bradycardia resuscitation',
    });

    expect(res.ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        verbalOrderStatus: 'cosigned',
        cosignNotes: 'Confirmed verbally ordered during bradycardia resuscitation',
      }),
    );
  });

  it('allows doctor to reject verbal order with logged audit rationale', async () => {
    const res = await rejectVerbalOrderAction({
      orderId: 'order-verbal-1',
      rejectionReason: 'Dose not verbally authorized by attending physician; administration recorded in error',
    });

    expect(res.ok).toBe(true);
    expect(mockSet).toHaveBeenCalledWith(
      expect.objectContaining({
        verbalOrderStatus: 'rejected',
        status: 'discontinued',
      }),
    );
    expect(mockInsert).toHaveBeenCalled();
  });

  it('refuses rejection without minimum 5-character clinical rationale', async () => {
    await expect(
      rejectVerbalOrderAction({
        orderId: 'order-verbal-1',
        rejectionReason: 'no',
      }),
    ).rejects.toThrow(/rationale/i);
  });
});
