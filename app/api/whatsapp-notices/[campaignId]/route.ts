import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import {
  getNoticeCampaignDetails,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = await requireSession();
    const { campaignId } = await ctx.params;

    const campaign = await getNoticeCampaignDetails({
      campaignId,
      hospitalId: session.hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
    });

    return NextResponse.json({ campaign });
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:details]', error);
    return NextResponse.json({ error: 'Failed to fetch notice campaign details' }, { status: 500 });
  }
}
