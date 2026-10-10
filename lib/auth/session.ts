import { cache } from 'react';
import { cookies, headers } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { registerRequestScope } from '@/lib/db/request-context';
import { markSessionOnRequest, resolveSession, type Session } from '@/lib/services/auth';
import { getPlanAccess } from '@/lib/services/subscriptions';

/*
 * The per-request record of read-only flag, staff user and origin
 * (lib/db/request-context.ts) is keyed by Next's headers object, which is one
 * object for the whole of a request and a different one for every request.
 * Outside a request (build, cache scopes) there is no key, and no record.
 */
registerRequestScope(async () => {
  try {
    return await headers();
  } catch (error) {
    unstable_rethrow(error);
    return null;
  }
});

const COOKIE_NAME = 'opd_session';
/** Set by proxy.ts on first visit: which browser or tablet a session and its entries came from. */
export const DEVICE_COOKIE_NAME = 'qurio_device';
/**
 * Set when this browser locks itself (app/api/session/lock), cleared on unlock.
 * While present, the session is read from the database rather than the cache,
 * so the lock takes effect on the very next page, not up to 30 seconds later.
 * It only ever makes a session stricter: a stolen cookie without it still
 * meets the lock in the database within the cache's lifetime.
 */
export const LOCK_HINT_COOKIE_NAME = 'qurio_locked';

/**
 * The session behind the cookie, whatever its state, including locked and
 * waiting for the monitoring notice. Only the unlock and notice screens and
 * requireSession() should need this; everything else uses getSession().
 */
const resolveSessionForRequest = cache(async function resolveSessionForRequest(): Promise<Session | null> {
  const store = await cookies();
  return resolveSession(store.get(COOKIE_NAME)?.value, { fresh: store.has(LOCK_HINT_COOKIE_NAME) });
});

/*
 * Marked again in every caller, after the cached lookup. React's cache() runs
 * resolveSession once per request, in whichever branch asked first (usually
 * the layout); the page, rendered alongside it, and anything else that only
 * reads the cached result would otherwise run its transactions without the
 * read-only flag, the staff user or the session/channel/device (the evidence
 * log found this: none was ever recorded from a browser). Marking is cheap
 * and synchronous.
 */
export async function getSessionState(): Promise<Session | null> {
  const session = await resolveSessionForRequest();
  if (session) await markSessionOnRequest(session);
  return session;
}

export async function clearLockHint() {
  (await cookies()).delete(LOCK_HINT_COOKIE_NAME);
}

/**
 * A session that may be used right now. A locked session, or one that has
 * not accepted a required notice, counts as no session, so a caller that
 * forgets the lock exists still refuses it (ADR-022).
 */
export async function getSession(): Promise<Session | null> {
  // Not cached itself: getSessionState must run in each caller to mark its context.
  const session = await getSessionState();
  return session && !session.locked && !session.noticePending ? session : null;
}

export async function readDeviceCookie(): Promise<string | null> {
  const value = (await cookies()).get(DEVICE_COOKIE_NAME)?.value;
  return value && /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : null;
}

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
  const session = await getSessionState();
  if (!session) redirect('/login');
  // A locked ward-tablet session goes back to "Who is recording?"; a locked phone to its unlock screen.
  if (session.locked) redirect(session.channel === 'ward_device' ? '/ward-device' : '/unlock');
  if (session.noticePending) redirect('/notice');
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
