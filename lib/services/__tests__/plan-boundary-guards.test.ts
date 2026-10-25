import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockPlanAccessResult: any = { state: 'open', hasAssignedPlan: true };

vi.mock('../subscriptions', () => ({
  getPlanAccess: vi.fn(() => Promise.resolve(mockPlanAccessResult)),
}));

vi.mock('@/lib/db', () => ({
  getDb: vi.fn(() => ({
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([])),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        returning: vi.fn(() => Promise.resolve([{ id: 'mock-user-id' }])),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => Promise.resolve()),
    })),
  })),
  withTenant: vi.fn((_tenantId: string, cb: any) =>
    cb({
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => Promise.resolve([{ timezone: 'Asia/Kolkata', branchId: 'b-1' }])),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn(() => ({
          returning: vi.fn(() => Promise.resolve([{ id: 'mock-membership-id' }])),
        })),
      })),
      delete: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve()),
      })),
    }),
  ),
}));

vi.mock('../entitlements', () => ({
  assertCanAdd: vi.fn(() => Promise.resolve()),
}));

import { bookScheduledSlot, BookingError } from '../web-booking';
import { createNoticeCampaignDraft, NoticeAuthError } from '../whatsapp-notices';
import { createStaffUser, StaffAccountError } from '../auth';

describe('plan boundary guards', () => {
  const hospitalId = 'hosp-test-1';

  beforeEach(() => {
    vi.clearAllMocks();
    mockPlanAccessResult = {
      state: 'open',
      hasAssignedPlan: true,
      endsAt: new Date(Date.now() + 86400000),
    };
  });

  describe('web booking boundary', () => {
    it('rejects online booking when plan is soft_locked', async () => {
      mockPlanAccessResult = {
        state: 'soft_locked',
        hasAssignedPlan: true,
        reason: 'lapsed',
        endedAt: new Date(Date.now() - 86400000 * 8),
        locksAt: new Date(Date.now() - 86400000),
      };

      await expect(
        bookScheduledSlot({
          hospitalId,
          doctorId: 'doc-1',
          patientName: 'Jane Patient',
          phoneE164: '+919876543210',
          slotDatetimeIso: new Date(Date.now() + 3600000).toISOString(),
        }),
      ).rejects.toMatchObject({
        code: 'NOT_TAKING_BOOKINGS',
      });
    });
  });

  describe('whatsapp notice campaign boundary', () => {
    it('rejects campaign draft creation when plan is soft_locked', async () => {
      mockPlanAccessResult = {
        state: 'soft_locked',
        hasAssignedPlan: true,
        reason: 'lapsed',
        endedAt: new Date(),
        locksAt: new Date(),
      };

      await expect(
        createNoticeCampaignDraft({
          hospitalId,
          actor: { userId: 'u-1', role: 'owner', hospitalId },
          noticeType: 'general_announcement',
          title: 'Clinic Notice',
          templateCode: 'clinic_notice',
        }),
      ).rejects.toBeInstanceOf(NoticeAuthError);
    });
  });

  describe('staff onboarding boundary', () => {
    it('rejects ordinary staff onboarding when plan is soft_locked', async () => {
      mockPlanAccessResult = {
        state: 'soft_locked',
        hasAssignedPlan: true,
        reason: 'lapsed',
        endedAt: new Date(),
        locksAt: new Date(),
      };

      await expect(
        createStaffUser({
          email: 'reception@example.com',
          name: 'Receptionist Bob',
          hospitalId,
          role: 'receptionist',
        }),
      ).rejects.toMatchObject({
        code: 'PLAN_SOFT_LOCKED',
      });
    });

    it('permits emergency doctor onboarding with clinical continuity reason when soft_locked', async () => {
      mockPlanAccessResult = {
        state: 'soft_locked',
        hasAssignedPlan: true,
        reason: 'lapsed',
        endedAt: new Date(),
        locksAt: new Date(),
      };

      const result = await createStaffUser({
        email: 'doctor.emergency@example.com',
        name: 'Dr. Emergency',
        hospitalId,
        role: 'doctor',
        emergencyClinicalReason: 'Critical ICU cover required for night shift',
      });

      expect(result.user).toBeDefined();
      expect(result.membership).toBeDefined();
    });
  });
});
