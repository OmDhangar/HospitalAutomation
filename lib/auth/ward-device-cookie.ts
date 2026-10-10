import { cookies } from 'next/headers';

/**
 * The cookie that marks a browser as an enrolled ward tablet (ADR-022). Long
 * lived and httpOnly: it is the tablet's credential, and only its hash is
 * stored. Separate from the session cookie, so a person switching user — or
 * their session ending — leaves the tablet enrolled.
 */
const COOKIE_NAME = 'qurio_ward_device';

/** Carries a just-made tablet code to Settings → Staff access for 15 minutes, instead of the URL. */
export const ENROL_FLASH_COOKIE = 'qurio_enrol_code';

export async function readWardDeviceCookie(): Promise<string | undefined> {
  return (await cookies()).get(COOKIE_NAME)?.value;
}

export async function setWardDeviceCookie(value: string) {
  (await cookies()).set(COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    // Browsers cap cookies at about 400 days; a tablet unused for 90 days stops working anyway.
    maxAge: 400 * 24 * 60 * 60,
  });
}

export async function clearWardDeviceCookie() {
  (await cookies()).delete(COOKIE_NAME);
}
