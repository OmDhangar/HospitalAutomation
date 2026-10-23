import { notFound, redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { getNoticeCampaignDetails } from '@/lib/services/whatsapp-notices';
import { CampaignProgressView } from '@/components/whatsapp-notices/campaign-progress-view';

export const metadata = {
  title: 'Notice Campaign Tracker | Hospital Admin',
  description: 'Track delivery progress and recipient status for WhatsApp notice campaign.',
};

export default async function NoticeCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const session = await requireSession();

  if (session.role !== 'owner' && session.role !== 'receptionist') {
    redirect('/dashboard');
  }

  let campaign;
  try {
    campaign = await getNoticeCampaignDetails({
      campaignId: id,
      hospitalId: session.hospitalId,
      actor: session,
    });
  } catch {
    notFound();
  }

  if (!campaign) {
    notFound();
  }

  return (
    <div className="max-w-6xl mx-auto py-4">
      <CampaignProgressView
        campaignId={id}
        hospitalId={session.hospitalId}
        initialCampaign={campaign as any}
      />
    </div>
  );
}
