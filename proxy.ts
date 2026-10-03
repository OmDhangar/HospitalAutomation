import { NextResponse, type NextRequest } from 'next/server';
import { isWardToken, wardSessionMayVisit } from '@/lib/domain/ward-pin';

/**
 * Keeps a PIN session on a shared ward tablet on the ward screens (T1.9).
 *
 * A PIN session already resolves as a nurse, so it could do no more than a
 * nurse anywhere; this is the second line: it never reaches the OPD queue,
 * settings or a patient's full record at all. It reads only the cookie's
 * prefix — no database — and every request it lets through is still
 * authenticated and authorised in full by the route itself.
 */
export function proxy(request: NextRequest) {
  const token = request.cookies.get('opd_session')?.value;
  if (!isWardToken(token)) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (wardSessionMayVisit(pathname)) return NextResponse.next();

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not available on a ward tablet' }, { status: 403 });
  }
  return NextResponse.redirect(new URL('/ipd/ward', request.url));
}

export const config = {
  // Everything except static assets; only PIN sessions are ever redirected.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/).*)'],
};
