'use server';

import { redirect } from 'next/navigation';
import { clearLockHint, clearSessionCookie, readSessionCookie, setSessionCookie } from '@/lib/auth/session';
import { readWardDeviceCookie, setWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { clientIp, ipRules, isThrottled, recordEvent } from '@/lib/security/throttle';
import { logout } from '@/lib/services/auth';
import { enrolWardDevice, resolveWardDevice, unlockWardDevice } from '@/lib/services/staff-access';

/**
 * The shared ward tablet (ADR-022): enrol it with the owner's one-time code,
 * unlock it with a person's PIN, and switch user.
 */

const PAGE = '/ward-device';
const ENROL_WINDOW_MS = 15 * 60_000;

/** The tablet types the code the owner created in Settings → Staff access. */
export async function enrolWardDeviceAction(form: FormData) {
  // A wrong code costs a try; ten per IP in fifteen minutes is plenty for a person, useless for guessing.
  const rules = ipRules(await clientIp(), { prefix: 'enrol:ip', limit: 10, windowMs: ENROL_WINDOW_MS });
  if (await isThrottled(rules)) redirect(`${PAGE}?error=${encodeURIComponent('Too many tries. Wait 15 minutes.')}`);

  const enrolled = await enrolWardDevice(String(form.get('code') ?? ''));
  if (!enrolled) {
    await recordEvent(rules.map((rule) => rule.key));
    redirect(`${PAGE}?error=${encodeURIComponent('That code is wrong or has expired. Ask the owner for a new one.')}`);
  }
  // Whoever was signed in on this browser before is signed out: it is a shared tablet now.
  await logout(await readSessionCookie());
  await clearSessionCookie();
  await setWardDeviceCookie(enrolled.cookieValue);
  redirect(`${PAGE}?enrolled=1`);
}

/** A person chosen on "Who is recording?" enters their PIN. */
export async function unlockWardDeviceAction(form: FormData) {
  const device = await resolveWardDevice(await readWardDeviceCookie());
  if (!device) redirect(PAGE);
  const userId = String(form.get('userId') ?? '');
  const pin = String(form.get('pin') ?? '').replace(/\D/g, '');
  const next = String(form.get('next') ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) redirect(PAGE);

  await logout(await readSessionCookie());
  const result = await unlockWardDevice({ device: device!, userId, pin });
  if (!result.ok) {
    redirect(`${PAGE}?user=${userId}&error=${encodeURIComponent(result.error)}`);
  }
  await setSessionCookie((result as { sessionToken: string }).sessionToken);
  await clearLockHint();
  // Back to where the last person's session ended, if that was on the ward; otherwise the IPD
  // home, which sends a nurse to the ward and a doctor to the overview.
  redirect(next.startsWith('/ipd') ? next : '/ipd');
}

/** "Switch user": ends this person's session; the tablet stays enrolled. */
export async function switchUserAction() {
  await logout(await readSessionCookie());
  await clearSessionCookie();
  redirect(PAGE);
}
