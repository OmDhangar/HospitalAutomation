import { NextResponse } from 'next/server';
import { LOCK_HINT_COOKIE_NAME, readSessionCookie } from '@/lib/auth/session';
import { lockSession } from '@/lib/services/staff-access';

/**
 * The page reports that this phone was idle or in the background too long, or
 * the person tapped Lock (ADR-022). A personal session is held locked on the
 * server until a PIN or password unlock; a ward-tablet session ends.
 *
 *   POST { reason: 'idle' | 'background' | 'manual' }
 *
 * Only same-origin requests: a lock is harmless, but another site should not
 * be able to lock someone out.
 */
export async function POST(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && new URL(origin).host !== request.headers.get('host')) {
    return NextResponse.json({ error: 'Not allowed' }, { status: 403 });
  }
  let reason: 'idle' | 'background' | 'manual' = 'manual';
  try {
    const body = (await request.json()) as { reason?: unknown };
    if (body.reason === 'idle' || body.reason === 'background') reason = body.reason;
  } catch {
    // No body: a manual lock.
  }
  const outcome = await lockSession(await readSessionCookie(), reason);
  if (!outcome) return NextResponse.json({ error: 'Sign in again' }, { status: 401 });
  const response = NextResponse.json({ outcome, next: outcome === 'ended' ? '/ward-device' : '/unlock' });
  // The next page reads the lock from the database, not a cache (lib/auth/session.ts).
  response.cookies.set(LOCK_HINT_COOKIE_NAME, '1', {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 24 * 60 * 60,
  });
  return response;
}
