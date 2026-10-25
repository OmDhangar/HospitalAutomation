import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockRedirect = vi.fn((path: string) => {
  throw new Error(`NEXT_REDIRECT:${path}`);
});

vi.mock('next/navigation', () => ({
  redirect: (path: string) => mockRedirect(path),
}));

vi.mock('next/headers', () => ({
  cookies: vi.fn(() =>
    Promise.resolve({
      get: () => undefined,
      has: () => false,
      set: () => {},
      delete: () => {},
    }),
  ),
}));

let mockSessionState: any = null;
vi.mock('@/lib/services/auth', () => ({
  resolveSession: vi.fn(() => Promise.resolve(mockSessionState)),
  markSessionOnRequest: vi.fn(() => Promise.resolve()),
}));

let mockPlanAccessResult: any = { state: 'open' };
vi.mock('@/lib/services/subscriptions', () => ({
  getPlanAccess: vi.fn(() => Promise.resolve(mockPlanAccessResult)),
}));

import { isPlanLocked, requireSession } from '../session';

describe('requireSession and isPlanLocked', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSessionState = {
      userId: 'user-1',
      hospitalId: 'hosp-1',
      hospitalName: 'Test Hospital',
      role: 'doctor',
      name: 'Dr. Test',
      timezone: 'Asia/Kolkata',
      locked: false,
      noticePending: false,
      mustChangePassword: false,
      isPlatformAdmin: false,
      impersonatedByUserId: null,
      channel: 'web',
      screenLock: { idleMs: 900000, backgroundMs: 60000 },
    };
    mockPlanAccessResult = { state: 'open' };
  });

  it('redirects to /login when no session exists', async () => {
    mockSessionState = null;
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT:/login');
  });

  it('redirects to /unlock when session is locked', async () => {
    mockSessionState.locked = true;
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT:/unlock');
  });

  it('redirects to /notice when noticePending is true', async () => {
    mockSessionState.noticePending = true;
    await expect(requireSession()).rejects.toThrow('NEXT_REDIRECT:/notice');
  });

  it('allows access without redirecting to /plan-inactive when plan is soft_locked', async () => {
    mockPlanAccessResult = {
      state: 'soft_locked',
      hasAssignedPlan: true,
      reason: 'lapsed',
      endedAt: new Date(),
      locksAt: new Date(),
    };
    const session = await requireSession();
    expect(session.userId).toBe('user-1');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('allows access without redirecting to /plan-inactive when plan is revoked', async () => {
    mockPlanAccessResult = {
      state: 'revoked',
      hasAssignedPlan: true,
      reason: 'suspended',
      endedAt: null,
    };
    const session = await requireSession();
    expect(session.userId).toBe('user-1');
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('correctly reports isPlanLocked for soft_locked and revoked', async () => {
    mockPlanAccessResult = { state: 'open' };
    expect(await isPlanLocked(mockSessionState)).toBe(false);

    mockPlanAccessResult = { state: 'soft_locked', hasAssignedPlan: true, reason: 'lapsed' };
    expect(await isPlanLocked(mockSessionState)).toBe(true);

    mockPlanAccessResult = { state: 'revoked', hasAssignedPlan: true, reason: 'suspended' };
    expect(await isPlanLocked(mockSessionState)).toBe(true);
  });
});
