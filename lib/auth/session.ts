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
