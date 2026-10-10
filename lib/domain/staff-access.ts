import { z } from 'zod';
import { STAFF_ROLES, type StaffRole } from '@/lib/domain/permissions';

/**
 * How staff sign in and stay signed in (ADR-022, IPD sheets plan §5). Pure.
 *
 * Two channels, both always available unless the owner turns one off for a role:
 *
 * - **ward_device**: a shared tablet enrolled once by the owner. It stays
 *   enrolled — a day or a week unused does not sign it out. Each person
 *   unlocks it with their own PIN; that person's session ends after
 *   10 minutes idle (the tablet goes back to "Who is recording?") and after
 *   24 hours at most.
 * - **personal**: the normal login on the person's own phone or a desk PC.
 *   Clinical roles lock after 15 minutes idle (5–30, the owner's choice) or
 *   5 minutes in the background, and unlock with their PIN or password. The
 *   lock is held on the server, so a copied cookie does not get past it.
 */

export const CHANNELS = ['personal', 'ward_device'] as const;
export type Channel = (typeof CHANNELS)[number];

/** Roles whose phones hold patient detail all day: locked after a short idle. */
export const CLINICAL_ROLES: readonly StaffRole[] = ['doctor', 'nurse'];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const WARD_IDLE_MS = 10 * MINUTE;
export const WARD_ABSOLUTE_MS = 24 * HOUR;
export const BACKGROUND_LOCK_MS = 5 * MINUTE;
export const CLINICAL_LOCK_MIN_MINUTES = 5;
export const CLINICAL_LOCK_MAX_MINUTES = 30;

/* --------------------------------------------------------- per-hospital settings */

export type AccessSettings = {
  /** Roles that may unlock a ward device with a PIN. */
  wardDeviceRoles: StaffRole[];
  /** Roles that may sign in on their own device. The owner always may. */
  personalRoles: StaffRole[];
  /** Idle minutes before a clinical role's personal session locks. */
  clinicalLockMinutes: number;
  /**
   * Whether staff must accept the monitoring notice before using the app.
   * Off until the hospital's counsel has approved the wording (legal item L3).
   */
  monitoringNotice: 'off' | 'required';
};

export const DEFAULT_ACCESS_SETTINGS: AccessSettings = {
  wardDeviceRoles: ['owner', 'doctor', 'nurse'],
  personalRoles: [...STAFF_ROLES],
  clinicalLockMinutes: 15,
  monitoringNotice: 'off',
};

const roleList = z.array(z.enum(STAFF_ROLES)).transform((roles) => [...new Set(roles)]);

const settingsSchema = z.object({
  wardDeviceRoles: roleList.optional(),
  personalRoles: roleList.optional(),
  clinicalLockMinutes: z.number().int().optional(),
  monitoringNotice: z.enum(['off', 'required']).optional(),
});

/**
 * The stored settings with defaults filled in and the guardrails applied: the
 * lock is clamped to 5–30 minutes, and the owner can always sign in on their
 * own device, so no setting can lock everyone out.
 */
export function parseAccessSettings(raw: unknown): AccessSettings {
  const parsed = settingsSchema.safeParse(raw ?? {});
  const value = parsed.success ? parsed.data : {};
  const personal = value.personalRoles ?? DEFAULT_ACCESS_SETTINGS.personalRoles;
  return {
    wardDeviceRoles: value.wardDeviceRoles ?? DEFAULT_ACCESS_SETTINGS.wardDeviceRoles,
    personalRoles: personal.includes('owner') ? personal : ['owner', ...personal],
    clinicalLockMinutes: Math.min(
      CLINICAL_LOCK_MAX_MINUTES,
      Math.max(CLINICAL_LOCK_MIN_MINUTES, value.clinicalLockMinutes ?? DEFAULT_ACCESS_SETTINGS.clinicalLockMinutes),
    ),
    monitoringNotice: value.monitoringNotice ?? DEFAULT_ACCESS_SETTINGS.monitoringNotice,
  };
}

export function channelAllowed(settings: AccessSettings, role: StaffRole, channel: Channel): boolean {
  return channel === 'ward_device' ? settings.wardDeviceRoles.includes(role) : settings.personalRoles.includes(role);
}

/**
 * What a person can do on a shared ward tablet. Admin and money work never
 * happens there: an owner acts as a doctor, a receptionist as a nurse. The
 * server enforces this through `can()`, because a page guard alone can be
 * bypassed by posting a server action from an allowed page.
 */
export function wardRoleFor(role: StaffRole): StaffRole {
  if (role === 'owner') return 'doctor';
  if (role === 'receptionist') return 'nurse';
  return role;
}

/* --------------------------------------------------------- session lifetime */

export type SessionRule = {
  /** No request for this long: lock (unlock with PIN or password) or end (sign in again). */
  idle: { ms: number; action: 'lock' | 'end' };
  /** From sign-in, whatever the activity. */
  absoluteMs: number;
  /** Hidden in the background this long: lock. Null where it does not apply. */
  backgroundLockMs: number | null;
  /** last_seen_at is written at most this often, to keep the database quiet. */
  lastSeenWriteMs: number;
};

export function sessionRule(role: StaffRole, channel: Channel, settings: AccessSettings): SessionRule {
  if (channel === 'ward_device') {
    return { idle: { ms: WARD_IDLE_MS, action: 'end' }, absoluteMs: WARD_ABSOLUTE_MS, backgroundLockMs: null, lastSeenWriteMs: MINUTE };
  }
  if (CLINICAL_ROLES.includes(role)) {
    return {
      idle: { ms: settings.clinicalLockMinutes * MINUTE, action: 'lock' },
      absoluteMs: 14 * DAY,
      backgroundLockMs: BACKGROUND_LOCK_MS,
      lastSeenWriteMs: MINUTE,
    };
  }
  if (role === 'owner') {
    return { idle: { ms: 8 * HOUR, action: 'end' }, absoluteMs: 7 * DAY, backgroundLockMs: null, lastSeenWriteMs: 5 * MINUTE };
  }
  return { idle: { ms: 12 * HOUR, action: 'end' }, absoluteMs: 14 * DAY, backgroundLockMs: null, lastSeenWriteMs: 5 * MINUTE };
}

export type SessionVerdict = 'active' | 'lock' | 'end';

/** Is a session still usable, given when it started, when it was last used, and its rule? */
export function sessionVerdict(args: {
  createdAt: Date;
  lastSeenAt: Date | null;
  lockedAt: Date | null;
  now: Date;
  rule: SessionRule;
}): SessionVerdict {
  const now = args.now.getTime();
  if (now - args.createdAt.getTime() > args.rule.absoluteMs) return 'end';
  if (args.lockedAt) return 'lock';
  const lastSeen = (args.lastSeenAt ?? args.createdAt).getTime();
  if (now - lastSeen > args.rule.idle.ms) return args.rule.idle.action;
  return 'active';
}

export const shouldWriteLastSeen = (lastSeenAt: Date | null, now: Date, rule: SessionRule): boolean =>
  lastSeenAt === null || now.getTime() - lastSeenAt.getTime() >= rule.lastSeenWriteMs;

/* ------------------------------------------------------------------------ PINs */

export const MAX_PIN_FAILURES = 5;
export const PIN_LOCK_MS = 15 * MINUTE;
/** Wrong PINs on one device in an hour before the device itself locks. */
export const MAX_DEVICE_FAILURES_PER_HOUR = 20;
export const DEVICE_LOCK_MS = HOUR;
/** A PIN works only for someone who signed in with their password this recently. */
export const PIN_NEEDS_PASSWORD_WITHIN_MS = 30 * DAY;

const OBVIOUS_PINS = new Set([
  '0000', '1111', '2222', '3333', '4444', '5555', '6666', '7777', '8888', '9999',
  '1234', '4321', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432',
  '1212', '2580', '0852', '1122', '1010', '0123', '1004', '2000',
]);

export type PinProblem = 'not_four_digits' | 'too_obvious' | 'looks_like_a_year';

export function pinProblem(pin: string): PinProblem | null {
  if (!/^\d{4}$/.test(pin)) return 'not_four_digits';
  if (OBVIOUS_PINS.has(pin)) return 'too_obvious';
  const year = Number(pin);
  if (year >= 1940 && year <= 2030) return 'looks_like_a_year';
  return null;
}

export const PIN_PROBLEM_MESSAGES: Record<PinProblem, string> = {
  not_four_digits: 'The PIN must be exactly 4 digits',
  too_obvious: 'Choose a PIN that is harder to guess',
  looks_like_a_year: 'A year (like a birth year) is easy to guess. Choose another PIN',
};

/** After a wrong PIN: the person's new count, and a lock if this was one too many. */
export function afterWrongPin(failedCount: number, now: Date): { failedCount: number; lockedUntil: Date | null } {
  const next = failedCount + 1;
  return next >= MAX_PIN_FAILURES
    ? { failedCount: 0, lockedUntil: new Date(now.getTime() + PIN_LOCK_MS) }
    : { failedCount: next, lockedUntil: null };
}

/** After a wrong PIN on a device: its count in the current hour, and a lock at twenty. */
export function afterDeviceFailure(
  state: { failedPins: number; windowStartedAt: Date | null },
  now: Date,
): { failedPins: number; windowStartedAt: Date; lockedUntil: Date | null } {
  const fresh = state.windowStartedAt === null || now.getTime() - state.windowStartedAt.getTime() > HOUR;
  const failedPins = (fresh ? 0 : state.failedPins) + 1;
  const windowStartedAt = fresh ? now : state.windowStartedAt!;
  return failedPins >= MAX_DEVICE_FAILURES_PER_HOUR
    ? { failedPins: 0, windowStartedAt: now, lockedUntil: new Date(now.getTime() + DEVICE_LOCK_MS) }
    : { failedPins, windowStartedAt, lockedUntil: null };
}

export const isLocked = (lockedUntil: Date | null, now: Date): boolean =>
  lockedUntil !== null && lockedUntil.getTime() > now.getTime();

/* ------------------------------------------------------------ device enrolment */

/** No 0/O, 1/I/L: read aloud or off a screen without mistakes. */
export const ENROL_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ENROL_CODE_LENGTH = 8;
export const ENROL_CODE_TTL_MS = 15 * MINUTE;
/** A device unused this long stops working and has to be enrolled again. */
export const DEVICE_UNUSED_LIMIT_MS = 90 * DAY;

/** From random bytes (one per character), so the caller supplies the randomness. */
export function enrolCodeFrom(bytes: Uint8Array): string {
  if (bytes.length < ENROL_CODE_LENGTH) throw new Error('not enough random bytes');
  let code = '';
  for (let i = 0; i < ENROL_CODE_LENGTH; i++) code += ENROL_CODE_ALPHABET[bytes[i] % ENROL_CODE_ALPHABET.length];
  return code;
}

/** What was typed, tidied: spaces and dashes dropped, upper case. Null if it cannot be a code. */
export function normalizeEnrolCode(input: string): string | null {
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== ENROL_CODE_LENGTH) return null;
  for (const ch of code) if (!ENROL_CODE_ALPHABET.includes(ch)) return null;
  return code;
}

export const formatEnrolCode = (code: string): string => `${code.slice(0, 4)}-${code.slice(4)}`;

/**
 * The device cookie: "<hospital id>.<random token>". The hospital id is not a
 * secret; carrying it lets the device be looked up under row-level security.
 * The token is what proves the device, and only its hash is stored.
 */
export function parseDeviceCookie(value: string | undefined): { hospitalId: string; token: string } | null {
  if (!value) return null;
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32,})$/i.exec(value);
  return match ? { hospitalId: match[1].toLowerCase(), token: match[2] } : null;
}

export const deviceUnusedTooLong = (lastSeenAt: Date | null, enrolledAt: Date, now: Date): boolean =>
  now.getTime() - (lastSeenAt ?? enrolledAt).getTime() > DEVICE_UNUSED_LIMIT_MS;

/* --------------------------------------------------------- ward session scope */

/**
 * Ward-session tokens carry this prefix so proxy.ts can keep them on IPD pages
 * without a database lookup. It identifies, it does not authorise: every
 * request is still resolved and checked in full, and the role is capped
 * (wardRoleFor) on the server.
 */
export const WARD_TOKEN_PREFIX = 'w_';

export const isWardToken = (token: string | undefined): boolean =>
  typeof token === 'string' && token.startsWith(WARD_TOKEN_PREFIX);

/** Paths a ward-device session may reach. Everything else goes back to the ward. */
export function wardSessionMayVisit(pathname: string): boolean {
  const under = (prefix: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);
  return (
    under('/ipd') ||
    under('/api/ipd') ||
    under('/api/session') ||
    under('/print/ipd-file') ||
    under('/ward-device') ||
    under('/notice') ||
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/icons/') ||
    pathname === '/manifest.webmanifest' ||
    pathname === '/favicon.ico'
  );
}
