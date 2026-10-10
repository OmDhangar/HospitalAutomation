'use server';

import { redirect } from 'next/navigation';
import { clearLockHint, clearSessionCookie, readSessionCookie } from '@/lib/auth/session';
import { clearEvents, isThrottled, recordEvent } from '@/lib/security/throttle';
import { logout } from '@/lib/services/auth';
import { unlockSession } from '@/lib/services/staff-access';

/**
 * Unlocking a phone that locked itself (ADR-022). A PIN has its own lock-out
 * (lib/services/staff-access.ts); a password is limited to five tries per
 * session in fifteen minutes, after which the session is ended and the person
 * signs in again from the start.
 */

const PAGE = '/unlock';
const PASSWORD_WINDOW_MS = 15 * 60_000;

const safeNext = (value: FormDataEntryValue | null) => {
  const next = String(value ?? '');
  return next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
};

export async function unlockWithPinAction(form: FormData) {
  const next = safeNext(form.get('next'));
  const result = await unlockSession({
    token: await readSessionCookie(),
    method: 'pin',
    secret: String(form.get('pin') ?? '').replace(/\D/g, ''),
  });
  if (!result.ok) {
    const query = new URLSearchParams({ error: result.error, next });
    if (result.usePassword) query.set('use', 'password');
    redirect(`${PAGE}?${query}`);
  }
  await clearLockHint();
  redirect(next);
}

export async function unlockWithPasswordAction(form: FormData) {
  const next = safeNext(form.get('next'));
  const token = await readSessionCookie();
  if (!token) redirect('/login');
  const rule = { key: `unlock:${token.slice(-16)}`, limit: 5, windowMs: PASSWORD_WINDOW_MS };
  if (await isThrottled([rule])) {
    await logout(token);
    await clearSessionCookie();
    redirect('/login?error=locked');
  }
  const result = await unlockSession({ token, method: 'password', secret: String(form.get('password') ?? '') });
  if (!result.ok) {
    await recordEvent([rule.key]);
    redirect(`${PAGE}?${new URLSearchParams({ error: result.error, next, use: 'password' })}`);
  }
  await clearEvents([rule.key]);
  await clearLockHint();
  redirect(next);
}

export async function signOutFromLockAction() {
  await logout(await readSessionCookie());
  await clearSessionCookie();
  await clearLockHint();
  redirect('/login');
}
