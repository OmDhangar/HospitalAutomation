import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireWritableSession } from '@/lib/auth/session';
import {
  saveCampaignMandatoryRecipients,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';

const saveMandatorySchema = z.object({
  recipients: z.array(
    z.object({
      phoneE164: z.string().min(1),
      patientId: z.string().uuid().nullable().optional(),
      patientName: z.string().optional(),
    }),
  ),
});

export async function PUT(
  request: Request,
  ctx: { params: Promise<{ campaignId: string }> },
) {
  try {
    const session = await requireWritableSession();
    const { campaignId } = await ctx.params;

    const body = await request.json();
    const parsed = saveMandatorySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid mandatory recipients payload', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await saveCampaignMandatoryRecipients({
      campaignId,
      hospitalId: session.hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
      recipients: parsed.data.recipients,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:save-mandatory]', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save mandatory recipients' },
      { status: 500 },
    );
  }
}
