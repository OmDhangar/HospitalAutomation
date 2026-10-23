import { NextResponse } from 'next/server';
import { requireWritableSession } from '@/lib/auth/session';
import {
  cancelNoticeCampaign,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = await requireWritableSession();
    const { campaignId } = await ctx.params;

    const result = await cancelNoticeCampaign({
      campaignId,
      hospitalId: session.hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
    });

    return NextResponse.json({
      success: true,
      cancelledRecipients: result.cancelledRecipients,
    });
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:cancel]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to cancel notice campaign' },
      { status: 500 },
    );
  }
}
