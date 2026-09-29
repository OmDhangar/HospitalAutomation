import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveSession, type Session } from '@/lib/services/auth';

const COOKIE_NAME = 'opd_session';

export const getSession = cache(async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return resolveSession(store.get(COOKIE_NAME)?.value);
});

/** For pages that must not render at all without a signed-in staff member. */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  return session;
}

export async function setSessionCookie(token: string) {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 14 * 24 * 60 * 60,
  });
}

export async function readSessionCookie(): Promise<string | undefined> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value;
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/**
 * Refuses a write on a read-only support session.
 *
 * The prohibition is enforced by row-level security, which cannot be bypassed
 * and does not depend on anybody remembering this call. This exists so that
 * the refusal arrives as a sentence rather than as a Postgres policy violation
 * halfway through a transaction, and so a mutation is rejected before it does
 * any of the work that precedes the write.
 */
export async function requireWritableSession(): Promise<Session> {
  const session = await requireSession();
  if (session.readOnly) {
    throw new Error(
      'This is a read-only support session. Stop the support session to make changes.',
    );
  }
  return session;
}
