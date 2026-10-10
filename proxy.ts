import { NextResponse, type NextRequest } from 'next/server';
import { isWardToken, wardSessionMayVisit } from '@/lib/domain/staff-access';

/**
 * Two small jobs before a request is handled (ADR-022):
 *
 * 1. **Device id.** A browser without a `qurio_device` cookie gets one: a
 *    random id, no personal data, that lets a session and the entries made in
 *    it be traced to the device (a lost phone, a shared tablet). It is a
 *    label, not a credential.
 * 2. **Ward-tablet scope.** A PIN session on a shared ward tablet stays on the
 *    IPD: other pages redirect to the ward, other APIs answer 403. This reads
 *    only the session token's prefix — no database — and is the second line:
 *    the first is on the server, where a ward session's role is capped
 *    (wardRoleFor), because a server action can be posted from any page.
 */

const DEVICE_COOKIE = 'qurio_device';
const DEVICE_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get('opd_session')?.value;

  if (isWardToken(token) && !wardSessionMayVisit(pathname)) {
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Not available on a ward tablet' }, { status: 403 });
    }
    return NextResponse.redirect(new URL('/ipd/ward', request.url));
  }

  const response = NextResponse.next();
  if (!request.cookies.get(DEVICE_COOKIE)) {
    response.cookies.set(DEVICE_COOKIE, crypto.randomUUID().replace(/-/g, ''), {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: DEVICE_COOKIE_MAX_AGE,
    });
  }
  return response;
}

export const config = {
  // Everything but static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icons/|.*\\.(?:png|svg|jpg|webp|ico)$).*)'],
};
