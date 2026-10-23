import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import {
  listCampaignRecipients,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';

export async function GET(
  request: Request,
  ctx: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = await requireSession();
    const { campaignId } = await ctx.params;
    const url = new URL(request.url);

    const page = url.searchParams.get('page') ? Number(url.searchParams.get('page')) : 1;
    const pageSize = url.searchParams.get('pageSize') ? Number(url.searchParams.get('pageSize')) : 25;
    const status = url.searchParams.get('status') ?? undefined;
    const search = url.searchParams.get('search') ?? undefined;

    const result = await listCampaignRecipients({
      campaignId,
      hospitalId: session.hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
      page,
      pageSize,
      status,
      search,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:recipients]', error);
    return NextResponse.json({ error: 'Failed to list campaign recipients' }, { status: 500 });
  }
}
