import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { searchPatientsSmart } from '@/lib/services/patient-search';

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

    const { searchParams } = new URL(request.url);
    const query = searchParams.get('q') ?? '';

    if (!query.trim()) {
      return NextResponse.json({ results: [] });
    }

    const results = await searchPatientsSmart({
      hospitalId,
      query,
      actorUserId: session.userId,
      limit: 10,
    });

    return NextResponse.json({ results });
  } catch (error) {
    if (error && typeof error === 'object' && 'digest' in error) throw error;
    console.error('[api:patients:search]', error);
    return NextResponse.json({ error: 'Failed to search patients' }, { status: 500 });
  }
}
