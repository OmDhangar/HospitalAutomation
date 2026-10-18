import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { resolveLookupRedirect } from './lookup-service';

export async function GET(request: NextRequest) {
  try {
    const session = await requireSession();
    const searchParams = request.nextUrl.searchParams;
    const uhid = searchParams.get('uhid');
    const patientId = searchParams.get('patientId');

    const redirectPath = await resolveLookupRedirect({
      hospitalId: session.hospitalId,
      uhid,
      patientId,
    });

    const destination = new URL(redirectPath, request.url);
    return NextResponse.redirect(destination, 307);
  } catch (err: any) {
    const errorUrl = new URL(
      `/ipd?error=${encodeURIComponent(err?.message || 'Unauthorized')}`,
      request.url,
    );
    return NextResponse.redirect(errorUrl, 307);
  }
}
