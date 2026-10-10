'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { clearSessionCookie, requireWritableSession } from '@/lib/auth/session';
import { StaffAccessError, setOwnPin, signOutEverywhere } from '@/lib/services/staff-access';

/** My login and PIN: a person's own PIN and their own sessions (ADR-022). */

const PAGE = '/account';
const back = (params: Record<string, string>): never => {
  revalidatePath(PAGE);
  redirect(`${PAGE}?${new URLSearchParams(params)}`);
};

export async function setOwnPinAction(form: FormData) {
  const session = await requireWritableSession();
  // A PIN is set from your own login, never from a shared tablet.
  if (session.channel !== 'personal') back({ error: 'Set your PIN from your own login, not a ward tablet' });
  const pin = String(form.get('pin') ?? '');
  if (pin !== String(form.get('confirm') ?? '')) back({ error: 'The two PINs do not match' });
  try {
    await setOwnPin({ hospitalId: session.hospitalId, userId: session.userId, pin, password: String(form.get('password') ?? '') });
  } catch (err) {
    if (err instanceof StaffAccessError) back({ error: err.message });
    throw err;
  }
  back({ saved: 'PIN saved. Use it on the ward tablet and to unlock your phone.' });
}

/** A lost phone: every session of mine ends, this one included. */
export async function signOutEverywhereAction() {
  const session = await requireWritableSession();
  await signOutEverywhere({ hospitalId: session.hospitalId, userId: session.userId, actorUserId: session.userId });
  await clearSessionCookie();
  redirect('/login');
}
