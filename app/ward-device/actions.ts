'use server';

import { redirect } from 'next/navigation';
import { clearSessionCookie, readSessionCookie, setSessionCookie } from '@/lib/auth/session';
import { readWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { logout } from '@/lib/services/auth';
import { resolveWardDevice, unlockWithPin } from '@/lib/services/ward-devices';

/**
 * Unlocks the ward tablet for one person. The device cookie proves the
 * tablet; the PIN proves the person; the resulting session is nurse-only
 * and ends after ten idle minutes.
 */
export async function unlockWardDeviceAction(form: FormData) {
  const device = await resolveWardDevice(await readWardDeviceCookie());
  if (!device) redirect('/ward-device');
  const userId = String(form.get('userId') ?? '');
  const pin = String(form.get('pin') ?? '').replace(/\D/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(userId)) redirect('/ward-device');

  // Whoever was signed in on the tablet before is signed out first.
  await logout(await readSessionCookie());
  const result = await unlockWithPin({ device: device!, userId, pin });
  if (!result.ok) {
    redirect(`/ward-device?user=${userId}&error=${encodeURIComponent(result.error)}`);
  }
  await setSessionCookie((result as { sessionToken: string }).sessionToken);
  redirect('/ipd/ward');
}

/** "Switch nurse": ends this PIN session and goes back to "Who is recording?". */
export async function switchNurseAction() {
  await logout(await readSessionCookie());
  await clearSessionCookie();
  redirect('/ward-device');
}
