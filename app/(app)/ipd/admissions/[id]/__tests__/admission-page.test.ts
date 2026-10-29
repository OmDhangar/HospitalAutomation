import { beforeEach, describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import AdmissionPage from '../page';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  requireSession: vi.fn(),
}));

describe('AdmissionPage redirect guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redirects unauthenticated users to login via requireSession', async () => {
    vi.mocked(requireSession).mockRejectedValueOnce(new Error('NEXT_REDIRECT:/login'));

    await expect(
      AdmissionPage({ params: Promise.resolve({ id: '0f9bc440-1881-4605-92cb-74d7fa3afa36' }) }),
    ).rejects.toThrow('NEXT_REDIRECT:/login');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('redirects authenticated doctor directly to /ipd/patients/[id]/summary', async () => {
    vi.mocked(requireSession).mockResolvedValueOnce({
      userId: 'user-doc',
      hospitalId: 'hosp-1',
      branchId: 'branch-1',
      role: 'doctor',
      readOnly: false,
      timezone: 'Asia/Kolkata',
    } as any);

    await AdmissionPage({ params: Promise.resolve({ id: '0f9bc440-1881-4605-92cb-74d7fa3afa36' }) });

    expect(redirect).toHaveBeenCalledWith(
      '/ipd/patients/0f9bc440-1881-4605-92cb-74d7fa3afa36/summary',
    );
  });

  it('redirects authenticated owner directly to /ipd/patients/[id]/summary', async () => {
    vi.mocked(requireSession).mockResolvedValueOnce({
      userId: 'user-owner',
      hospitalId: 'hosp-1',
      branchId: 'branch-1',
      role: 'owner',
      readOnly: false,
      timezone: 'Asia/Kolkata',
    } as any);

    await AdmissionPage({ params: Promise.resolve({ id: '0f9bc440-1881-4605-92cb-74d7fa3afa36' }) });

    expect(redirect).toHaveBeenCalledWith(
      '/ipd/patients/0f9bc440-1881-4605-92cb-74d7fa3afa36/summary',
    );
  });

  it('redirects authenticated nurse to /ipd/patients/[id]/emar', async () => {
    vi.mocked(requireSession).mockResolvedValueOnce({
      userId: 'user-nurse',
      hospitalId: 'hosp-1',
      branchId: 'branch-1',
      role: 'nurse',
      readOnly: false,
      timezone: 'Asia/Kolkata',
    } as any);

    await AdmissionPage({ params: Promise.resolve({ id: '0f9bc440-1881-4605-92cb-74d7fa3afa36' }) });

    expect(redirect).toHaveBeenCalledWith(
      '/ipd/patients/0f9bc440-1881-4605-92cb-74d7fa3afa36/emar',
    );
  });
});
