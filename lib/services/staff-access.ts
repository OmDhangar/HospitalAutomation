import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { getDb, withTenant, type Tx } from '@/lib/db';
import {
  auditLogs,
  branches,
  hospitalFeatures,
  policyAcknowledgements,
  sessions,
  staffMemberships,
  staffPins,
  users,
  wardDevices,
} from '@/lib/db/schema';
import { MONITORING_NOTICE_KEY, MONITORING_NOTICE_VERSION, type NoticeLocale } from '@/lib/domain/monitoring-notice';
import type { StaffRole } from '@/lib/domain/permissions';
import {
  ENROL_CODE_LENGTH,
  ENROL_CODE_TTL_MS,
  PIN_NEEDS_PASSWORD_WITHIN_MS,
  PIN_PROBLEM_MESSAGES,
  WARD_ABSOLUTE_MS,
  WARD_TOKEN_PREFIX,
  afterDeviceFailure,
  afterWrongPin,
  channelAllowed,
  deviceUnusedTooLong,
  enrolCodeFrom,
  isLocked,
  normalizeEnrolCode,
  parseAccessSettings,
  parseDeviceCookie,
  pinProblem,
  CLINICAL_LOCK_MAX_MINUTES,
  CLINICAL_LOCK_MIN_MINUTES,
  type AccessSettings,
  type Channel,
} from '@/lib/domain/staff-access';
import { hashPassword, verifyPassword } from '@/lib/security/password';
import { generateSessionToken, hashToken } from '@/lib/security/tokens';
import { invalidateSessionCache } from '@/lib/services/auth';

/**
 * Both staff access modes (ADR-022, IPD sheets plan §5, phase A5-min).
 *
 * Mode A, a shared ward tablet: the owner creates a device and gets a
 * one-time code; the tablet types it and is enrolled. It then shows "Who is
 * recording?" and each person unlocks it with their own PIN, for a session
 * that is theirs, not the tablet's.
 *
 * Mode B, a personal device: the normal login, locked on the server after
 * idle or background time (lib/services/auth.ts) and unlocked here with the
 * person's PIN or password.
 *
 * `sessions` has no row-level security (0001), so, as in auth.ts, this module
 * is one of the two places that write it.
 */

export class StaffAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaffAccessError';
  }
}

const STAFF_ACCESS_MODULE = 'staff_access';
// A PIN check takes as long whether or not the person has a PIN.
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);

const audit = (
  tx: Tx,
  hospitalId: string,
  actorUserId: string | null,
  action: string,
  object: { type: string; id: string | null },
  metadata?: Record<string, unknown>,
) =>
  tx.insert(auditLogs).values({ hospitalId, actorUserId, action, objectType: object.type, objectId: object.id, metadata });

/* ------------------------------------------------------------------ settings */

export async function getAccessSettings(hospitalId: string): Promise<AccessSettings> {
  const [row] = await withTenant(hospitalId, (tx) =>
    tx
      .select({ settings: hospitalFeatures.settings })
      .from(hospitalFeatures)
      .where(and(eq(hospitalFeatures.hospitalId, hospitalId), eq(hospitalFeatures.moduleId, STAFF_ACCESS_MODULE))),
  );
  return parseAccessSettings(row?.settings);
}

export async function updateAccessSettings(args: {
  hospitalId: string;
  wardDeviceRoles: StaffRole[];
  personalRoles: StaffRole[];
  clinicalLockMinutes: number;
  monitoringNotice: 'off' | 'required';
  actorUserId: string;
}): Promise<AccessSettings> {
  if (!Number.isInteger(args.clinicalLockMinutes) || args.clinicalLockMinutes < CLINICAL_LOCK_MIN_MINUTES || args.clinicalLockMinutes > CLINICAL_LOCK_MAX_MINUTES) {
    throw new StaffAccessError(`The lock must be between ${CLINICAL_LOCK_MIN_MINUTES} and ${CLINICAL_LOCK_MAX_MINUTES} minutes`);
  }
  const settings = parseAccessSettings({
    wardDeviceRoles: args.wardDeviceRoles,
    personalRoles: args.personalRoles,
    clinicalLockMinutes: args.clinicalLockMinutes,
    monitoringNotice: args.monitoringNotice,
  });
  for (const role of ['receptionist', 'doctor', 'nurse'] as const) {
    if (!settings.wardDeviceRoles.includes(role) && !settings.personalRoles.includes(role)) {
      throw new StaffAccessError(`Leave at least one way to sign in for ${role}s`);
    }
  }
  await withTenant(args.hospitalId, async (tx) => {
    const [before] = await tx
      .select({ settings: hospitalFeatures.settings })
      .from(hospitalFeatures)
      .where(and(eq(hospitalFeatures.hospitalId, args.hospitalId), eq(hospitalFeatures.moduleId, STAFF_ACCESS_MODULE)));
    await tx
      .insert(hospitalFeatures)
      .values({ hospitalId: args.hospitalId, moduleId: STAFF_ACCESS_MODULE, state: 'on', settings, updatedByUserId: args.actorUserId })
      .onConflictDoUpdate({
        target: [hospitalFeatures.hospitalId, hospitalFeatures.moduleId],
        set: { settings, updatedByUserId: args.actorUserId, updatedAt: new Date() },
      });
    await audit(tx, args.hospitalId, args.actorUserId, 'auth.access_settings_changed', { type: 'module', id: STAFF_ACCESS_MODULE }, {
      from: parseAccessSettings(before?.settings),
      to: settings,
    });
  });
  // Sessions whose channel was just switched off end at their next resolve.
  invalidateSessionCache();
  return settings;
}

/* --------------------------------------------------------------- ward devices */

export type WardDevice = {
  id: string;
  hospitalId: string;
  branchId: string;
  name: string;
  wardIds: string[];
  lockedUntil: Date | null;
};

function newEnrolCode(): { code: string; hash: string; expiresAt: Date } {
  const code = enrolCodeFrom(randomBytes(ENROL_CODE_LENGTH));
  return { code, hash: hashToken(code), expiresAt: new Date(Date.now() + ENROL_CODE_TTL_MS) };
}

/** The owner names a tablet and gets a one-time code to type on it (valid 15 minutes). */
export async function createWardDevice(args: {
  hospitalId: string;
  branchId: string;
  name: string;
  wardIds: string[];
  actorUserId: string;
}): Promise<{ deviceId: string; code: string; expiresAt: Date }> {
  const name = args.name.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 60) throw new StaffAccessError('Name the tablet, like “Ward A tablet”');
  const enrol = newEnrolCode();
  return withTenant(args.hospitalId, async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, args.branchId));
    if (!branch) throw new StaffAccessError('Choose a branch');
    const [device] = await tx
      .insert(wardDevices)
      .values({
        hospitalId: args.hospitalId,
        branchId: branch.id,
        name,
        wardIds: args.wardIds,
        enrolCodeHash: enrol.hash,
        enrolExpiresAt: enrol.expiresAt,
        createdByUserId: args.actorUserId,
      })
      .returning({ id: wardDevices.id });
    await audit(tx, args.hospitalId, args.actorUserId, 'auth.ward_device_created', { type: 'ward_device', id: device.id }, { name });
    return { deviceId: device.id, code: enrol.code, expiresAt: enrol.expiresAt };
  });
}

/** A fresh code for a tablet that is not yet enrolled, or to move enrolment to a new tablet. */
export async function renewEnrolCode(args: {
  hospitalId: string;
  deviceId: string;
  actorUserId: string;
}): Promise<{ code: string; expiresAt: Date }> {
  const enrol = newEnrolCode();
  await withTenant(args.hospitalId, async (tx) => {
    const [device] = await tx
      .update(wardDevices)
      .set({ enrolCodeHash: enrol.hash, enrolExpiresAt: enrol.expiresAt, tokenHash: null, enrolledAt: null })
      .where(and(eq(wardDevices.id, args.deviceId), isNull(wardDevices.revokedAt)))
      .returning({ id: wardDevices.id });
    if (!device) throw new StaffAccessError('Tablet not found');
    await audit(tx, args.hospitalId, args.actorUserId, 'auth.ward_device_code_renewed', { type: 'ward_device', id: device.id });
  });
  // A re-enrolment ends the sessions of the tablet it replaces.
  await getDb().delete(sessions).where(eq(sessions.wardDeviceId, args.deviceId));
  invalidateSessionCache();
  return enrol;
}

/**
 * The tablet types its code. Returns the device cookie value, which the caller
 * sets httpOnly; only its hash is stored. The code works once.
 */
export async function enrolWardDevice(rawCode: string): Promise<{ cookieValue: string; deviceName: string } | null> {
  const code = normalizeEnrolCode(rawCode);
  if (!code) return null;
  const codeHash = hashToken(code);
  // The one lookup made before any hospital is known (0042, resolve_ward_enrolment).
  const [found] = await getDb().execute<{ hospital_id: string | null }>(
    sql`select public.resolve_ward_enrolment(${codeHash}) as hospital_id`,
  );
  const hospitalId = found?.hospital_id;
  if (!hospitalId) return null;

  const token = generateSessionToken();
  return withTenant(hospitalId, async (tx) => {
    const [device] = await tx
      .update(wardDevices)
      .set({ tokenHash: hashToken(token), enrolledAt: new Date(), lastSeenAt: new Date(), enrolCodeHash: null, enrolExpiresAt: null })
      .where(and(eq(wardDevices.enrolCodeHash, codeHash), isNull(wardDevices.enrolledAt), isNull(wardDevices.revokedAt)))
      .returning({ id: wardDevices.id, name: wardDevices.name });
    if (!device) return null;
    await audit(tx, hospitalId, null, 'auth.ward_device_enrolled', { type: 'ward_device', id: device.id });
    return { cookieValue: `${hospitalId}.${token}`, deviceName: device.name };
  });
}

const LAST_SEEN_DEVICE_WRITE_MS = 5 * 60_000;

/** The tablet behind a device cookie, if it is enrolled, not revoked and used in the last 90 days. */
export async function resolveWardDevice(cookieValue: string | undefined): Promise<WardDevice | null> {
  const parsed = parseDeviceCookie(cookieValue);
  if (!parsed) return null;
  return withTenant(parsed.hospitalId, async (tx) => {
    const [device] = await tx
      .select()
      .from(wardDevices)
      .where(and(eq(wardDevices.tokenHash, hashToken(parsed.token)), isNull(wardDevices.revokedAt)));
    if (!device || !device.enrolledAt) return null;
    const now = new Date();
    if (deviceUnusedTooLong(device.lastSeenAt, device.enrolledAt, now)) return null;
    if (!device.lastSeenAt || now.getTime() - device.lastSeenAt.getTime() > LAST_SEEN_DEVICE_WRITE_MS) {
      await tx.update(wardDevices).set({ lastSeenAt: now }).where(eq(wardDevices.id, device.id));
    }
    return {
      id: device.id,
      hospitalId: device.hospitalId,
      branchId: device.branchId,
      name: device.name,
      wardIds: device.wardIds,
      lockedUntil: device.lockedUntil,
    };
  });
}

export async function listWardDevices(hospitalId: string) {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: wardDevices.id,
        name: wardDevices.name,
        branchName: branches.name,
        wardIds: wardDevices.wardIds,
        createdAt: wardDevices.createdAt,
        enrolledAt: wardDevices.enrolledAt,
        enrolExpiresAt: wardDevices.enrolExpiresAt,
        lastSeenAt: wardDevices.lastSeenAt,
        revokedAt: wardDevices.revokedAt,
        lockedUntil: wardDevices.lockedUntil,
      })
      .from(wardDevices)
      .innerJoin(branches, eq(branches.id, wardDevices.branchId))
      .orderBy(sql`${wardDevices.revokedAt} is not null`, asc(wardDevices.name)),
  );
}

/** Revoking ends every session on the tablet at once; the tablet must be enrolled again to be used. */
export async function revokeWardDevice(args: { hospitalId: string; deviceId: string; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    const [device] = await tx
      .update(wardDevices)
      .set({ revokedAt: new Date(), revokedByUserId: args.actorUserId, enrolCodeHash: null, enrolExpiresAt: null })
      .where(and(eq(wardDevices.id, args.deviceId), isNull(wardDevices.revokedAt)))
      .returning({ id: wardDevices.id });
    if (!device) throw new StaffAccessError('Tablet not found');
    await audit(tx, args.hospitalId, args.actorUserId, 'auth.ward_device_revoked', { type: 'ward_device', id: device.id });
  });
  await getDb().delete(sessions).where(eq(sessions.wardDeviceId, args.deviceId));
  invalidateSessionCache();
}

/** After too many wrong PINs the tablet locks for an hour; the owner may lift it sooner. */
export async function clearWardDeviceLock(args: { hospitalId: string; deviceId: string; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .update(wardDevices)
      .set({ lockedUntil: null, failedPins: 0, failedWindowStartedAt: null })
      .where(eq(wardDevices.id, args.deviceId));
    await audit(tx, args.hospitalId, args.actorUserId, 'auth.ward_device_lock_cleared', { type: 'ward_device', id: args.deviceId });
  });
}

/* ----------------------------------------------------------------------- PINs */

/**
 * A person sets their own PIN, signed in on their own login, and confirms with
 * their password — so someone who picks up an unlocked phone cannot set one.
 */
export async function setOwnPin(args: { hospitalId: string; userId: string; pin: string; password: string }): Promise<void> {
  const problem = pinProblem(args.pin);
  if (problem) throw new StaffAccessError(PIN_PROBLEM_MESSAGES[problem]);
  const [user] = await getDb().select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, args.userId));
  if (!user || !(await verifyPassword(args.password, user.passwordHash))) {
    throw new StaffAccessError('Your password is not correct');
  }
  const pinHash = await hashPassword(args.pin);
  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .insert(staffPins)
      .values({ hospitalId: args.hospitalId, userId: args.userId, pinHash })
      .onConflictDoUpdate({
        target: [staffPins.hospitalId, staffPins.userId],
        set: { pinHash, failedCount: 0, lockedUntil: null, setAt: new Date(), updatedAt: new Date() },
      });
    await audit(tx, args.hospitalId, args.userId, 'auth.pin_set', { type: 'user', id: args.userId });
  });
}

export async function hasPin(hospitalId: string, userId: string): Promise<{ hasPin: boolean; lockedUntil: Date | null }> {
  const [row] = await withTenant(hospitalId, (tx) =>
    tx
      .select({ lockedUntil: staffPins.lockedUntil })
      .from(staffPins)
      .where(and(eq(staffPins.hospitalId, hospitalId), eq(staffPins.userId, userId))),
  );
  return { hasPin: Boolean(row), lockedUntil: row?.lockedUntil ?? null };
}

/** The owner clears a forgotten PIN; the person sets a new one. Their tablet sessions end. */
export async function resetPin(args: { hospitalId: string; userId: string; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    await tx.delete(staffPins).where(and(eq(staffPins.hospitalId, args.hospitalId), eq(staffPins.userId, args.userId)));
    await audit(tx, args.hospitalId, args.actorUserId, 'auth.pin_reset', { type: 'user', id: args.userId });
  });
  await getDb()
    .delete(sessions)
    .where(and(eq(sessions.userId, args.userId), eq(sessions.channel, 'ward_device')));
  invalidateSessionCache();
}

type PinCheck = { ok: true } | { ok: false; error: string; personLocked?: boolean; deviceLocked?: boolean };

/**
 * One PIN check, with both lock-outs: five wrong tries lock the person's PIN
 * on every device for 15 minutes; twenty on one tablet in an hour lock the
 * tablet. Failures are committed even though the check fails.
 */
async function checkPinInTx(
  tx: Tx,
  args: { hospitalId: string; userId: string; pin: string; deviceId: string | null; now: Date },
): Promise<PinCheck> {
  const [row] = await tx
    .select()
    .from(staffPins)
    .where(and(eq(staffPins.hospitalId, args.hospitalId), eq(staffPins.userId, args.userId)))
    .for('update');
  const [device] = args.deviceId
    ? await tx.select().from(wardDevices).where(eq(wardDevices.id, args.deviceId)).for('update')
    : [undefined];

  if (device && isLocked(device.lockedUntil, args.now)) {
    return { ok: false, error: 'This tablet is locked after too many wrong PINs. Ask the owner, or wait an hour.', deviceLocked: true };
  }
  if (row && isLocked(row.lockedUntil, args.now)) {
    return { ok: false, error: 'Too many wrong PINs. Wait 15 minutes, or use your password.', personLocked: true };
  }

  const correct = await verifyPassword(args.pin, row?.pinHash ?? DUMMY_HASH);
  if (row && correct) {
    if (row.failedCount > 0) {
      await tx
        .update(staffPins)
        .set({ failedCount: 0, updatedAt: args.now })
        .where(and(eq(staffPins.hospitalId, args.hospitalId), eq(staffPins.userId, args.userId)));
    }
    return { ok: true };
  }

  const person = row ? afterWrongPin(row.failedCount, args.now) : null;
  if (row && person) {
    await tx
      .update(staffPins)
      .set({ failedCount: person.failedCount, lockedUntil: person.lockedUntil, updatedAt: args.now })
      .where(and(eq(staffPins.hospitalId, args.hospitalId), eq(staffPins.userId, args.userId)));
  }
  const tablet = device ? afterDeviceFailure({ failedPins: device.failedPins, windowStartedAt: device.failedWindowStartedAt }, args.now) : null;
  if (device && tablet) {
    await tx
      .update(wardDevices)
      .set({ failedPins: tablet.failedPins, failedWindowStartedAt: tablet.windowStartedAt, lockedUntil: tablet.lockedUntil })
      .where(eq(wardDevices.id, device.id));
  }
  // A guess against a made-up person is still counted against the tablet: the
  // audit row names the person only if they exist (a foreign key otherwise
  // fails, and with it the count that locks the tablet).
  await audit(tx, args.hospitalId, row ? args.userId : null, 'auth.pin_failed', { type: 'user', id: args.userId }, {
    deviceId: args.deviceId,
    personLocked: Boolean(person?.lockedUntil),
    deviceLocked: Boolean(tablet?.lockedUntil),
  });
  if (tablet?.lockedUntil) {
    await audit(tx, args.hospitalId, null, 'auth.ward_device_locked', { type: 'ward_device', id: device!.id });
    return { ok: false, error: 'This tablet is now locked for an hour after too many wrong PINs.', deviceLocked: true };
  }
  if (person?.lockedUntil) {
    return { ok: false, error: 'Too many wrong PINs. Wait 15 minutes, or use your password.', personLocked: true };
  }
  return { ok: false, error: 'Wrong PIN' };
}

/** "Who is recording?": people who may unlock this tablet, with a PIN set. */
export async function listPinPeople(device: WardDevice): Promise<{ userId: string; name: string }[]> {
  const settings = await getAccessSettings(device.hospitalId);
  const rows = await withTenant(device.hospitalId, (tx) =>
    tx
      .select({ userId: users.id, name: users.name, role: staffMemberships.role })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .innerJoin(staffPins, and(eq(staffPins.userId, staffMemberships.userId), eq(staffPins.hospitalId, staffMemberships.hospitalId)))
      .where(
        and(
          eq(staffMemberships.active, true),
          eq(users.active, true),
          or(isNull(staffMemberships.branchId), eq(staffMemberships.branchId, device.branchId)),
        ),
      )
      .orderBy(asc(users.name)),
  );
  return rows.filter((row) => channelAllowed(settings, row.role, 'ward_device')).map(({ userId, name }) => ({ userId, name }));
}

export type UnlockResult = { ok: true; sessionToken: string } | { ok: false; error: string };

/**
 * A person unlocks a ward tablet with their PIN. The session is theirs:
 * attributed to them, capped to ward work (wardRoleFor), ending after 10 idle
 * minutes or 24 hours. A PIN works only for someone who signed in with their
 * password in the last 30 days.
 */
export async function unlockWardDevice(args: { device: WardDevice; userId: string; pin: string; now?: Date }): Promise<UnlockResult> {
  const now = args.now ?? new Date();
  const { device } = args;
  const settings = await getAccessSettings(device.hospitalId);
  const [user] = await getDb()
    .select({ active: users.active, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.id, args.userId));

  const verdict = await withTenant(device.hospitalId, async (tx): Promise<PinCheck> => {
    const [member] = await tx
      .select({ role: staffMemberships.role, branchId: staffMemberships.branchId })
      .from(staffMemberships)
      .where(and(eq(staffMemberships.userId, args.userId), eq(staffMemberships.active, true)));
    const check = await checkPinInTx(tx, { hospitalId: device.hospitalId, userId: args.userId, pin: args.pin, deviceId: device.id, now });
    if (!check.ok) return check;
    if (!member || !user?.active || !channelAllowed(settings, member.role, 'ward_device')) {
      return { ok: false, error: 'This login cannot use a ward tablet. Use your own phone or the desk.' };
    }
    if (member.branchId !== null && member.branchId !== device.branchId) {
      return { ok: false, error: 'This tablet belongs to another branch.' };
    }
    if (!user.lastLoginAt || now.getTime() - user.lastLoginAt.getTime() > PIN_NEEDS_PASSWORD_WITHIN_MS) {
      return { ok: false, error: 'Sign in once with your password on any device; your PIN works for 30 days after that.' };
    }
    await audit(tx, device.hospitalId, args.userId, 'auth.pin_login', { type: 'ward_device', id: device.id });
    return { ok: true };
  });
  if (!verdict.ok) return verdict;

  const token = WARD_TOKEN_PREFIX + generateSessionToken();
  await getDb().insert(sessions).values({
    userId: args.userId,
    hospitalId: device.hospitalId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + WARD_ABSOLUTE_MS),
    channel: 'ward_device',
    wardDeviceId: device.id,
    deviceId: device.id,
    lastSeenAt: now,
  });
  return { ok: true, sessionToken: token };
}

/* ------------------------------------------------- personal lock and unlock */

type SessionRow = {
  id: string;
  userId: string;
  hospitalId: string;
  channel: Channel;
  lockedAt: Date | null;
  impersonatedByUserId: string | null;
};

async function sessionByToken(token: string | undefined): Promise<SessionRow | null> {
  if (!token) return null;
  const [row] = await getDb()
    .select({
      id: sessions.id,
      userId: sessions.userId,
      hospitalId: sessions.hospitalId,
      channel: sessions.channel,
      lockedAt: sessions.lockedAt,
      impersonatedByUserId: sessions.impersonatedByUserId,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, hashToken(token)), sql`${sessions.expiresAt} > now()`));
  return row ?? null;
}

/**
 * The phone was idle or in the background too long (reported by the page) or
 * the person pressed Lock. A personal session is held locked; a ward-tablet
 * session ends, and the tablet goes back to "Who is recording?".
 */
export async function lockSession(token: string | undefined, reason: 'idle' | 'background' | 'manual'): Promise<'locked' | 'ended' | null> {
  const row = await sessionByToken(token);
  if (!row || row.impersonatedByUserId) return null;
  const db = getDb();
  if (row.channel === 'ward_device') {
    await db.delete(sessions).where(eq(sessions.id, row.id));
  } else if (!row.lockedAt) {
    await db.update(sessions).set({ lockedAt: new Date() }).where(eq(sessions.id, row.id));
  }
  invalidateSessionCache(token);
  await withTenant(row.hospitalId, (tx) =>
    audit(tx, row.hospitalId, row.userId, row.channel === 'ward_device' ? 'auth.switch_user' : 'auth.session_locked', { type: 'user', id: row.userId }, { reason }),
  );
  return row.channel === 'ward_device' ? 'ended' : 'locked';
}

/** Unlocks a locked personal session with the person's PIN or password. */
export async function unlockSession(args: {
  token: string | undefined;
  method: 'pin' | 'password';
  secret: string;
  now?: Date;
}): Promise<{ ok: true } | { ok: false; error: string; usePassword?: boolean }> {
  const now = args.now ?? new Date();
  const row = await sessionByToken(args.token);
  if (!row || row.channel !== 'personal') return { ok: false, error: 'Sign in again' };

  let check: PinCheck;
  if (args.method === 'pin') {
    check = await withTenant(row.hospitalId, (tx) =>
      checkPinInTx(tx, { hospitalId: row.hospitalId, userId: row.userId, pin: args.secret, deviceId: null, now }),
    );
  } else {
    const [user] = await getDb().select({ passwordHash: users.passwordHash, active: users.active }).from(users).where(eq(users.id, row.userId));
    const correct = await verifyPassword(args.secret, user?.passwordHash ?? DUMMY_HASH);
    check = user?.active && correct ? { ok: true } : { ok: false, error: 'Incorrect password' };
  }
  if (!check.ok) return { ok: false, error: check.error, usePassword: check.personLocked };

  await getDb().update(sessions).set({ lockedAt: null, lastSeenAt: now }).where(eq(sessions.id, row.id));
  invalidateSessionCache(args.token);
  await withTenant(row.hospitalId, (tx) =>
    audit(tx, row.hospitalId, row.userId, 'auth.session_unlocked', { type: 'user', id: row.userId }, { method: args.method }),
  );
  return { ok: true };
}

/* ------------------------------------------------------------- sessions list */

export async function listUserSessions(userId: string, hospitalId: string) {
  return getDb()
    .select({
      id: sessions.id,
      channel: sessions.channel,
      deviceId: sessions.deviceId,
      createdAt: sessions.createdAt,
      lastSeenAt: sessions.lastSeenAt,
      lockedAt: sessions.lockedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.hospitalId, hospitalId), isNull(sessions.impersonatedByUserId), sql`${sessions.expiresAt} > now()`))
    .orderBy(desc(sessions.lastSeenAt));
}

/** Ends every session of a person at this hospital: a lost phone, or someone leaving. */
export async function signOutEverywhere(args: { hospitalId: string; userId: string; actorUserId: string }): Promise<number> {
  const ended = await getDb()
    .delete(sessions)
    .where(and(eq(sessions.userId, args.userId), eq(sessions.hospitalId, args.hospitalId), isNull(sessions.impersonatedByUserId)))
    .returning({ id: sessions.id });
  invalidateSessionCache();
  await withTenant(args.hospitalId, (tx) =>
    audit(tx, args.hospitalId, args.actorUserId, 'auth.signed_out_everywhere', { type: 'user', id: args.userId }, { sessions: ended.length }),
  );
  return ended.length;
}

/** Staff who may use a PIN, whether they have one, for Settings → Staff access. */
export async function listPinStatus(hospitalId: string) {
  return withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .select({
        userId: users.id,
        name: users.name,
        role: staffMemberships.role,
        pinSetAt: staffPins.setAt,
        pinLockedUntil: staffPins.lockedUntil,
      })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .leftJoin(staffPins, and(eq(staffPins.userId, staffMemberships.userId), eq(staffPins.hospitalId, staffMemberships.hospitalId)))
      .where(and(eq(staffMemberships.hospitalId, hospitalId), eq(staffMemberships.active, true)))
      .orderBy(asc(users.name));
    return rows;
  });
}

/* --------------------------------------------------------- monitoring notice */

export async function acceptMonitoringNotice(args: {
  hospitalId: string;
  userId: string;
  locale: NoticeLocale;
  channel: Channel;
  deviceId: string | null;
  token: string | undefined;
}): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    await tx
      .insert(policyAcknowledgements)
      .values({
        hospitalId: args.hospitalId,
        userId: args.userId,
        policyKey: MONITORING_NOTICE_KEY,
        policyVersion: MONITORING_NOTICE_VERSION,
        locale: args.locale,
        channel: args.channel,
        deviceId: args.deviceId,
      })
      .onConflictDoNothing();
    await audit(tx, args.hospitalId, args.userId, 'policy.acknowledged', { type: 'policy', id: MONITORING_NOTICE_KEY }, {
      version: MONITORING_NOTICE_VERSION,
      locale: args.locale,
    });
  });
  invalidateSessionCache(args.token);
}

/** Who has accepted the current notice, for the owner. */
export async function listNoticeAcceptance(hospitalId: string): Promise<Set<string>> {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({ userId: policyAcknowledgements.userId })
      .from(policyAcknowledgements)
      .where(
        and(
          eq(policyAcknowledgements.hospitalId, hospitalId),
          eq(policyAcknowledgements.policyKey, MONITORING_NOTICE_KEY),
          inArray(policyAcknowledgements.policyVersion, [MONITORING_NOTICE_VERSION]),
        ),
      ),
  );
  return new Set(rows.map((row) => row.userId));
}
