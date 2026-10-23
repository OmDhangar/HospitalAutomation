import { NextResponse } from 'next/server';
import { z } from 'zod';
import { requireSession, requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import {
  createNoticeCampaignDraft,
  listNoticeCampaigns,
  NoticeAuthError,
} from '@/lib/services/whatsapp-notices';
import type { NoticeType } from '@/lib/db/schema';

const createNoticeSchema = z.object({
  noticeType: z.enum(['hospital_closure', 'doctor_schedule_change', 'appointment_change']),
  title: z.string().min(1).max(200),
  closureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  closureDuration: z.string().max(100).optional(),
  reason: z.string().max(500).optional(),
  rescheduleInstructions: z.string().max(500).optional(),
  contactPhone: z.string().max(30).optional(),
  templateCode: z.string().min(1),
  templateVariables: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(
  request: Request,
  ctx: { params: Promise<{ hospitalId: string }> },
) {
  try {
    const session = await requireSession();
    const { hospitalId } = await ctx.params;

    if (!session.isPlatformAdmin && session.hospitalId !== hospitalId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const campaigns = await listNoticeCampaigns({
      hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
    });

    return NextResponse.json({ campaigns });
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:list]', error);
    return NextResponse.json({ error: 'Failed to list notice campaigns' }, { status: 500 });
  }
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ hospitalId: string }> },
) {
  try {
    const session = await requireWritableSession();
    const { hospitalId } = await ctx.params;

    if (!session.isPlatformAdmin && session.hospitalId !== hospitalId) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const body = await request.json();
    const parsed = createNoticeSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid notice parameters', issues: parsed.error.issues },
        { status: 400 },
      );
    }

    const result = await createNoticeCampaignDraft({
      hospitalId,
      actor: {
        userId: session.userId,
        role: session.role,
        hospitalId: session.hospitalId,
        isPlatformAdmin: session.isPlatformAdmin,
      },
      noticeType: parsed.data.noticeType as NoticeType,
      title: parsed.data.title,
      closureDate: parsed.data.closureDate,
      closureDuration: parsed.data.closureDuration,
      reason: parsed.data.reason,
      rescheduleInstructions: parsed.data.rescheduleInstructions,
      contactPhone: parsed.data.contactPhone,
      templateCode: parsed.data.templateCode,
      templateVariables: parsed.data.templateVariables,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    if (error instanceof NoticeAuthError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    console.error('[api:whatsapp-notices:create]', error);
    return NextResponse.json({ error: 'Failed to create notice campaign draft' }, { status: 500 });
  }
}
