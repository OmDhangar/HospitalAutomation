'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { requireWritableSession } from '@/lib/auth/session';
import { ENROL_FLASH_COOKIE } from '@/lib/auth/ward-device-cookie';
import { can, isStaffRole } from '@/lib/domain/permissions';
import {
  StaffAccessError,
  clearWardDeviceLock,
  createWardDevice,
  renewEnrolCode,
  resetPin,
  revokeWardDevice,
  signOutEverywhere,
  updateAccessSettings,
} from '@/lib/services/staff-access';

/**
 * Settings → Staff access (ADR-022), owner only. A new tablet code is passed
 * to the page in a short-lived httpOnly cookie, never in the URL, so it does
 * not land in browser history or server logs.
 */

const PAGE = '/settings/staff-access';

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'hospital.configure')) throw new Error('Only the hospital owner can change staff access');
  return session;
}

const back = (params: Record<string, string>): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params)}`);
};

const text = (form: FormData, key: string) => String(form.get(key) ?? '');

async function attempt<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StaffAccessError) back({ error: err.message });
    throw err;
  }
}

async function flashCode(deviceId: string, code: string, expiresAt: Date) {
  (await cookies()).set(ENROL_FLASH_COOKIE, JSON.stringify({ deviceId, code, expiresAt: expiresAt.toISOString() }), {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.NODE_ENV === 'production',
    path: PAGE,
    maxAge: 15 * 60,
  });
}

export async function addWardDeviceAction(form: FormData) {
  const session = await authorize();
  const created = await attempt(() =>
    createWardDevice({
      hospitalId: session.hospitalId,
      branchId: text(form, 'branchId'),
      name: text(form, 'name'),
      wardIds: [],
      actorUserId: session.userId,
    }),
  );
  await flashCode(created.deviceId, created.code, created.expiresAt);
  back({ saved: 'Tablet added. Type the code below on the tablet.', id: created.deviceId });
}

export async function renewWardDeviceCodeAction(form: FormData) {
  const session = await authorize();
  const deviceId = text(form, 'deviceId');
  const renewed = await attempt(() => renewEnrolCode({ hospitalId: session.hospitalId, deviceId, actorUserId: session.userId }));
  await flashCode(deviceId, renewed.code, renewed.expiresAt);
  back({ saved: 'New code made. The tablet must type it to be used again.', id: deviceId });
}

export async function revokeWardDeviceAction(form: FormData) {
  const session = await authorize();
  await attempt(() => revokeWardDevice({ hospitalId: session.hospitalId, deviceId: text(form, 'deviceId'), actorUserId: session.userId }));
  back({ saved: 'Tablet removed. Everyone on it has been signed out.' });
}

export async function clearWardDeviceLockAction(form: FormData) {
  const session = await authorize();
  await clearWardDeviceLock({ hospitalId: session.hospitalId, deviceId: text(form, 'deviceId'), actorUserId: session.userId });
  back({ saved: 'Tablet unlocked' });
}

export async function saveAccessSettingsAction(form: FormData) {
  const session = await authorize();
  const roles = (key: string) => form.getAll(key).map(String).filter(isStaffRole);
  await attempt(() =>
    updateAccessSettings({
      hospitalId: session.hospitalId,
      wardDeviceRoles: roles('wardDeviceRoles'),
      personalRoles: roles('personalRoles'),
      clinicalLockMinutes: Number(text(form, 'clinicalLockMinutes')),
      monitoringNotice: text(form, 'monitoringNotice') === 'required' ? 'required' : 'off',
      actorUserId: session.userId,
    }),
  );
  back({ saved: 'Sign-in rules saved. They apply now.', id: 'settings' });
}

export async function resetPinAction(form: FormData) {
  const session = await authorize();
  await resetPin({ hospitalId: session.hospitalId, userId: text(form, 'userId'), actorUserId: session.userId });
  back({ saved: 'PIN cleared. They set a new one under “My login and PIN”.' });
}

export async function signOutStaffEverywhereAction(form: FormData) {
  const session = await authorize();
  const count = await signOutEverywhere({ hospitalId: session.hospitalId, userId: text(form, 'userId'), actorUserId: session.userId });
  back({ saved: `Signed out of ${count} session${count === 1 ? '' : 's'}` });
}

