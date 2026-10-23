import { NextResponse } from 'next/server';
import { requireWritableSession } from '@/lib/auth/session';
import {
  confirmNoticeCampaign,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';
import { InsufficientCapacityError } from '@/lib/services/notice-capacity';
import { SelectionCapacityConflictError } from '@/lib/domain/notice-selection';

export async function POST(
  request: Request,
  ctx: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = await requireWritableSession();
    const { campaignId } = await ctx.params;

    const idempotencyKey = request.headers.get('idempotency-key') ?? undefined;

    const result = await confirmNoticeCampaign({
      campaignId,
      hospitalId: session.hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
      idempotencyKey,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    if (
      error instanceof InsufficientCapacityError ||
      error instanceof SelectionCapacityConflictError
    ) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error('[api:whatsapp-notices:confirm]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to confirm notice campaign' },
      { status: 500 },
    );
  }
}
