import { cookies } from 'next/headers';

/**
 * The cookie that marks a browser as a registered ward tablet (T1.9). Long
 * lived and httpOnly: it is the device's credential, and only its hash is
 * stored. Separate from the session cookie, so signing out — or a PIN
 * session ending — leaves the tablet registered.
 */
const COOKIE_NAME = 'qurio_ward_device';

export async function readWardDeviceCookie(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_NAME)?.value;
}

export async function setWardDeviceCookie(value: string) {
  (await cookies()).set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Browsers cap cookies at about 400 days; re-registering is one tap.
    maxAge: 400 * 24 * 60 * 60,
  });
}

export async function clearWardDeviceCookie() {
  (await cookies()).delete(COOKIE_NAME);
}
