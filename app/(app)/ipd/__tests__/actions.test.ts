import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  saveRoundDraftAction,
  signRoundOrdersAction,
} from '../actions';
import { AuthorNotLinkedDoctorError } from '@/lib/services/ipd-medication-orders';

let currentSession = {
  hospitalId: 'hosp-1',
  branchId: 'branch-1',
  userId: 'user-123',
  role: 'doctor' as const,
};

let mockLinkedDoctor: { id: string } | null = null;

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireWritableSession: vi.fn(() => Promise.resolve(currentSession)),
}));

vi.mock('@/lib/db', () => ({
  withTenant: vi.fn((_hospitalId: string, fn: (tx: any) => Promise<any>) => {
    const tx = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve(mockLinkedDoctor ? [mockLinkedDoctor] : []),
        }),
      }),
    };
    return fn(tx);
  }),
}));

vi.mock('@/lib/services/ipd-rounding-cockpit', () => ({
  saveRoundDraft: vi.fn().mockResolvedValue({ roundId: 'round-123' }),
  recordAllergyAssessment: vi.fn(),
}));

vi.mock('@/lib/services/ipd-medication-orders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/services/ipd-medication-orders')>();
  return {
    ...actual,
    signRoundOrders: vi.fn().mockResolvedValue({
      roundId: 'round-123',
      signedOrderIds: ['order-1'],
    }),
  };
});

describe('Clinical Round Actions Attribution Enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentSession = {
      hospitalId: 'hosp-1',
      branchId: 'branch-1',
      userId: 'user-doc-1',
      role: 'doctor',
    };
    mockLinkedDoctor = { id: 'doc-profile-1' };
  });

  it('allows linked doctor to save round draft under their own doctorId', async () => {
    const res = await saveRoundDraftAction({
      admissionId: 'adm-1',
      notes: 'Patient stable, vitals normal.',
    });

    expect(res.ok).toBe(true);
    expect(res.roundId).toBe('round-123');
  });

  it('throws AuthorNotLinkedDoctorError if user is not linked to any doctor profile', async () => {
    mockLinkedDoctor = null;

    await expect(
      saveRoundDraftAction({
        admissionId: 'adm-1',
        notes: 'Trying to sign without doctor profile',
      }),
    ).rejects.toThrow(AuthorNotLinkedDoctorError);
  });

  it('rejects requestedDoctorId override that attempts to impersonate another doctor', async () => {
    mockLinkedDoctor = { id: 'doc-profile-1' };

    await expect(
      saveRoundDraftAction({
        admissionId: 'adm-1',
        notes: 'Impersonating another doctor',
        doctorId: 'doc-profile-2',
      }),
    ).rejects.toThrow(/mismatch/i);
  });

  it('allows signing round orders when authenticated user is linked doctor', async () => {
    mockLinkedDoctor = { id: 'doc-profile-1' };

    const res = await signRoundOrdersAction({
      admissionId: 'adm-1',
      notes: 'Discharge pending lab results',
      resolutions: [],
    });

    expect(res.ok).toBe(true);
    expect(res.signedOrderIds).toContain('order-1');
  });

  it('rejects signing round orders when author is not linked doctor', async () => {
    mockLinkedDoctor = null;

    await expect(
      signRoundOrdersAction({
        admissionId: 'adm-1',
        notes: 'Nurse attempting to sign round',
        resolutions: [],
      }),
    ).rejects.toThrow(AuthorNotLinkedDoctorError);
  });
});
