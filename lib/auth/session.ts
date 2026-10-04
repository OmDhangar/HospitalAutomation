import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { resolveSession, type Session } from '@/lib/services/auth';
import { getPlanAccess } from '@/lib/services/subscriptions';

const COOKIE_NAME = 'opd_session';

export const getSession = cache(async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return resolveSession(store.get(COOKIE_NAME)?.value);
});

type SessionOptions = {
  /**
   * For the few screens a hospital still needs once its plan is revoked or
   * lapsed: the app shell, the plan-inactive page and renewal itself.
   */
  allowInactivePlan?: boolean;
};

/** Once per request, however many components ask. */
const planAccessFor = cache((hospitalId: string) => getPlanAccess(hospitalId));

/**
 * Whether this session is stopped by its hospital's plan.
 *
 * Platform operators are never stopped: they are the ones who revoke a plan
 * and need to look into the hospital afterwards.
 */
export async function isPlanLocked(session: Session): Promise<boolean> {
  if (session.isPlatformAdmin || session.impersonatedByUserId !== null) return false;
  return (await planAccessFor(session.hospitalId)).state === 'locked';
}

/**
 * For pages that must not render at all without a signed-in staff member.
 *
 * Also where a revoked or lapsed plan takes effect. Every page and every
 * server action passes through here, so a locked hospital is stopped at the
 * door rather than by hiding links.
 */
export async function requireSession(options: SessionOptions = {}): Promise<Session> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!options.allowInactivePlan && (await isPlanLocked(session))) redirect('/plan-inactive');
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
export async function requireWritableSession(options: SessionOptions = {}): Promise<Session> {
  const session = await requireSession(options);
  if (session.readOnly) {
    throw new Error(
      'This is a read-only support session. Stop the support session to make changes.',
    );
  }
  /**
   * A temporary password buys a password change and nothing else. The layout
   * already redirects such a session to /change-password, but a layout is not
   * a security boundary — a server action is reachable by POST whether it ran
   * or not — so the refusal lives here, where every write passes.
   */
  if (session.mustChangePassword) {
    throw new Error('Choose your own password before making changes.');
  }
  return session;
}
