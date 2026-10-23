import { describe, expect, it, vi } from 'vitest';
import {
  createNoticeCampaignDraft,
  saveCampaignMandatoryRecipients,
  previewNoticeSelection,
  confirmNoticeCampaign,
  cancelNoticeCampaign,
  listNoticeCampaigns,
  getNoticeCampaignDetails,
  NoticeAuthError,
} from '../whatsapp-notices';

vi.mock('@/lib/notify/notice-worker', () => ({
  drainNoticeCampaignOutbox: vi.fn().mockResolvedValue({ processed: 0, sent: 0, failed: 0, suppressed: 0 }),
}));

describe('whatsapp-notices service auth and role restrictions', () => {
  const hospitalId = '11111111-1111-1111-1111-111111111111';
  const otherHospitalId = '22222222-2222-2222-2222-222222222222';

  it('rejects unauthorized users with mismatched hospital IDs on create', async () => {
    const receptionistOther = {
      userId: 'user-rec',
      role: 'receptionist',
      hospitalId: otherHospitalId,
    };

    await expect(
      createNoticeCampaignDraft({
        hospitalId,
        actor: receptionistOther,
        noticeType: 'hospital_closure',
        title: 'Unauthorized draft',
        templateCode: 'hospital_closure_notice',
      }),
    ).rejects.toThrow(NoticeAuthError);
  });

  it('rejects unauthorized roles (nurse, doctor, accountant) from managing notices', async () => {
    for (const role of ['nurse', 'doctor', 'accountant', 'lab_technician']) {
      const actor = {
        userId: `user-${role}`,
        role,
        hospitalId,
      };

      await expect(
        createNoticeCampaignDraft({
          hospitalId,
          actor,
          noticeType: 'hospital_closure',
          title: 'Restricted draft',
          templateCode: 'hospital_closure_notice',
        }),
      ).rejects.toThrow(NoticeAuthError);

      await expect(
        previewNoticeSelection({
          hospitalId,
          actor,
          closureDate: '2026-10-24',
        }),
      ).rejects.toThrow(NoticeAuthError);

      await expect(
        listNoticeCampaigns({
          hospitalId,
          actor,
        }),
      ).rejects.toThrow(NoticeAuthError);

      await expect(
        getNoticeCampaignDetails({
          campaignId: 'c-1',
          hospitalId,
          actor,
        }),
      ).rejects.toThrow(NoticeAuthError);

      await expect(
        saveCampaignMandatoryRecipients({
          campaignId: 'c-1',
          hospitalId,
          actor,
          recipients: [],
        }),
      ).rejects.toThrow(NoticeAuthError);

      await expect(
        confirmNoticeCampaign({
          campaignId: 'c-1',
          hospitalId,
          actor,
        }),
      ).rejects.toThrow(NoticeAuthError);

      await expect(
        cancelNoticeCampaign({
          campaignId: 'c-1',
          hospitalId,
          actor,
        }),
      ).rejects.toThrow(NoticeAuthError);
    }
  });

  it('allows owner and receptionist roles from the same hospital', async () => {
    // Both roles should pass assertCanManageNotices without throwing NoticeAuthError
    const owner = { userId: 'u-1', role: 'owner', hospitalId };
    const receptionist = { userId: 'u-2', role: 'receptionist', hospitalId };

    // When hospitalId matches and role is owner or receptionist, NoticeAuthError is not thrown
    // (A db error or missing record may follow, but not NoticeAuthError)
    await expect(
      getNoticeCampaignDetails({
        campaignId: '00000000-0000-0000-0000-000000000000',
        hospitalId,
        actor: owner,
      }),
    ).rejects.not.toThrow(NoticeAuthError);

    await expect(
      getNoticeCampaignDetails({
        campaignId: '00000000-0000-0000-0000-000000000000',
        hospitalId,
        actor: receptionist,
      }),
    ).rejects.not.toThrow(NoticeAuthError);
  });
});
