/**
 * PINs and sessions on shared ward devices (IPD plan §5.6, task T1.9). Pure.
 *
 * A 4-digit PIN has ten thousand values, so what protects it is not its
 * length but the lock-out: five wrong tries lock that person on that device
 * for fifteen minutes, which makes guessing take years. The obvious PINs are
 * refused at set-up, since they are what is tried first.
 */

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 15 * 60_000;
/** A PIN session ends after this long with no request. */
export const WARD_SESSION_IDLE_MS = 10 * 60_000;
/**
 * PIN session tokens carry this prefix, so the proxy can keep them on the
 * ward screens without a database lookup. It identifies, it does not
 * authorise: the session is still resolved and checked in full.
 */
export const WARD_TOKEN_PREFIX = 'w_';

const OBVIOUS = new Set(['1234', '4321', '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999', '1212', '2580', '0852']);

export type PinProblem = 'not_four_digits' | 'too_obvious';

export function pinProblem(pin: string): PinProblem | null {
  if (!/^\d{4}$/.test(pin)) return 'not_four_digits';
  if (OBVIOUS.has(pin)) return 'too_obvious';
  return null;
}

export const PIN_PROBLEM_MESSAGES: Record<PinProblem, string> = {
  not_four_digits: 'The PIN must be exactly 4 digits',
  too_obvious: 'Choose a PIN that is harder to guess',
};

/** After a wrong PIN: the new count, and a lock if this was one too many. */
export function afterWrongPin(failedCount: number, now: Date): { failedCount: number; lockedUntil: Date | null } {
  const next = failedCount + 1;
  return next >= MAX_PIN_FAILURES
    ? { failedCount: 0, lockedUntil: new Date(now.getTime() + PIN_LOCK_MS) }
    : { failedCount: next, lockedUntil: null };
}

export const isLocked = (lockedUntil: Date | null, now: Date): boolean =>
  lockedUntil !== null && lockedUntil.getTime() > now.getTime();

/** The ward session's sliding expiry: renewed when less than this remains. */
export const shouldSlideWardSession = (expiresAt: Date, now: Date): boolean =>
  expiresAt.getTime() - now.getTime() < WARD_SESSION_IDLE_MS - 60_000;

export const isWardToken = (token: string | undefined): boolean =>
  typeof token === 'string' && token.startsWith(WARD_TOKEN_PREFIX);

/**
 * Paths a PIN session may reach: the ward screens, their API, and what a
 * page needs to load. Everything else sends it back to the ward.
 */
export function wardSessionMayVisit(pathname: string): boolean {
  return (
    pathname === '/ipd/ward' ||
    pathname.startsWith('/ipd/ward/') ||
    pathname.startsWith('/api/ipd/care-entries') ||
    pathname === '/api/ipd/items/search' ||
    pathname.startsWith('/ward-device') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/favicon.ico' ||
    pathname === '/login'
  );
}

/**
 * The device cookie: "<hospital id>.<random token>". The hospital id is not a
 * secret; carrying it lets the device be looked up under row-level security
 * without a privileged function. The token is what proves the device.
 */
export function parseDeviceCookie(value: string | undefined): { hospitalId: string; token: string } | null {
  if (!value) return null;
  const match = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{32,})$/.exec(value);
  return match ? { hospitalId: match[1], token: match[2] } : null;
}
