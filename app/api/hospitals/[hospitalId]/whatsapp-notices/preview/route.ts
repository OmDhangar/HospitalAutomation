import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import {
  previewNoticeSelection,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';

const previewSchema = z.object({
  campaignId: z.string().uuid().optional(),
  closureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  closureEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mandatoryRecipients: z
    .array(
      z.object({
        phoneE164: z.string().min(1),
        patientId: z.string().uuid().nullable().optional(),
        patientName: z.string().optional(),
      }),
    )
    .optional(),
});

export async function POST(
  request: Request,
  ctx: { params: Promise<{ hospitalId: string }> },
) {
  try {
    const session = await requireSession();
    const { hospitalId } = await ctx.params;

    if (!session.isPlatformAdmin && session.hospitalId !== hospitalId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const parsed = previewSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid preview parameters', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const preview = await previewNoticeSelection({
      hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
      campaignId: parsed.data.campaignId,
      closureDate: parsed.data.closureDate,
      closureEndDate: parsed.data.closureEndDate,
      mandatoryRecipients: parsed.data.mandatoryRecipients,
    });

    return NextResponse.json(preview);
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:preview]', error);
    return NextResponse.json({ error: 'Failed to calculate recipient preview' }, { status: 500 });
  }
}
