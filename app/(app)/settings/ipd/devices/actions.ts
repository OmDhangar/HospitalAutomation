'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { setWardDeviceCookie } from '@/lib/auth/ward-device-cookie';
import { can } from '@/lib/domain/permissions';
import { WardDeviceError, clearPin, registerWardDevice, revokeWardDevice } from '@/lib/services/ward-devices';

const PAGE = '/settings/ipd/devices';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'ipd.configure')) throw new Error('Only the hospital owner manages ward devices');
  return session;
}

const back = (params: Record<string, string>): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params).toString()}`);
};

/**
 * Registers the browser this is submitted from. The owner does it on the
 * ward tablet itself, then signs out; from then on the tablet opens on
 * "Who is recording?".
 */
export async function registerThisDeviceAction(form: FormData) {
  const session = await authorize();
  try {
    const { cookieValue } = await registerWardDevice({
      hospitalId: session.hospitalId,
      branchId: String(form.get('branchId') ?? ''),
      label: String(form.get('label') ?? ''),
      actorUserId: session.userId,
    });
    await setWardDeviceCookie(cookieValue);
  } catch (err) {
    if (err instanceof WardDeviceError) back({ error: err.message });
    throw err;
  }
  back({ saved: 'This device is now a ward tablet. Sign out, and nurses can tap their name and PIN.' });
}

export async function revokeDeviceAction(form: FormData) {
  const session = await authorize();
  try {
    await revokeWardDevice({
      hospitalId: session.hospitalId,
      deviceId: String(form.get('deviceId') ?? ''),
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof WardDeviceError) back({ error: err.message });
    throw err;
  }
  back({ saved: 'Device removed. Anyone signed in on it has been signed out.' });
}

export async function clearPinAction(form: FormData) {
  const session = await authorize();
  await clearPin({ hospitalId: session.hospitalId, userId: String(form.get('userId') ?? ''), actorUserId: session.userId });
  back({ saved: 'PIN cleared. They can set a new one after signing in with their own login.' });
}
