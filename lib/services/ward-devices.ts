import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import { getDb, withTenant } from '@/lib/db';
import {
  auditLogs,
  branches,
  sessions,
  staffMemberships,
  users,
  wardDevicePinAttempts,
  wardDevices,
} from '@/lib/db/schema';
import { can, STAFF_ROLES } from '@/lib/domain/permissions';
import {
  PIN_PROBLEM_MESSAGES,
  WARD_SESSION_IDLE_MS,
  WARD_TOKEN_PREFIX,
  afterWrongPin,
  isLocked,
  parseDeviceCookie,
  pinProblem,
} from '@/lib/domain/ward-pin';
import { hashPassword, verifyPassword } from '@/lib/security/password';
import { generateSessionToken, hashToken } from '@/lib/security/tokens';
import { invalidateSessionCache } from '@/lib/services/auth';

/**
 * Shared ward devices and nurse PINs (IPD plan §5.6, task T1.9; decision
 * D-DV). The device proves itself with a long-lived cookie whose hash is
 * stored here; a person proves themselves with a 4-digit PIN, guarded by a
 * lock-out. Together they open a short, nurse-only session.
 */

export class WardDeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WardDeviceError';
  }
}

/** Roles that may record at the bedside, and so may unlock a ward device. */
const RECORDING_ROLES = STAFF_ROLES.filter((role) => can(role, 'ipd.record'));

export type WardDevice = { id: string; hospitalId: string; branchId: string; label: string };

/**
 * Registers the device the owner is holding. Returns the cookie value; the
 * caller sets it httpOnly. Only its hash is stored, so a database leak does
 * not unlock any tablet.
 */
export async function registerWardDevice(args: {
  hospitalId: string;
  branchId: string;
  label: string;
  actorUserId: string;
}): Promise<{ cookieValue: string; deviceId: string }> {
  const label = args.label.trim().replace(/\s+/g, ' ');
  if (!label || label.length > 60) throw new WardDeviceError('Name the device, like “Ward A tablet”');
  const token = generateSessionToken();
  return withTenant(args.hospitalId, async (tx) => {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(eq(branches.id, args.branchId));
    if (!branch) throw new WardDeviceError('Branch not found');
    const [device] = await tx
      .insert(wardDevices)
      .values({
        hospitalId: args.hospitalId,
        branchId: branch.id,
        label,
        tokenHash: hashToken(token),
        registeredByUserId: args.actorUserId,
      })
      .returning({ id: wardDevices.id });
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'ipd.ward_device_registered',
      objectType: 'ward_device',
      objectId: device.id,
      metadata: { label },
    });
    return { cookieValue: `${args.hospitalId}.${token}`, deviceId: device.id };
  });
}

export async function listWardDevices(hospitalId: string) {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({
        id: wardDevices.id,
        label: wardDevices.label,
        branchName: branches.name,
        registeredAt: wardDevices.registeredAt,
        lastSeenAt: wardDevices.lastSeenAt,
        revokedAt: wardDevices.revokedAt,
      })
      .from(wardDevices)
      .innerJoin(branches, eq(branches.id, wardDevices.branchId))
      .orderBy(asc(wardDevices.revokedAt), asc(wardDevices.label)),
  );
}

/** Revoking ends every PIN session on the device at once. */
export async function revokeWardDevice(args: { hospitalId: string; deviceId: string; actorUserId: string }) {
  await withTenant(args.hospitalId, async (tx) => {
    const [device] = await tx
      .update(wardDevices)
      .set({ revokedAt: new Date() })
      .where(and(eq(wardDevices.id, args.deviceId), isNull(wardDevices.revokedAt)))
      .returning({ id: wardDevices.id });
    if (!device) throw new WardDeviceError('Device not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'ipd.ward_device_revoked',
      objectType: 'ward_device',
      objectId: device.id,
    });
  });
  // Sessions sit outside row-level security (0001), as at logout.
  await getDb().delete(sessions).where(eq(sessions.wardDeviceId, args.deviceId));
  invalidateSessionCache();
}

/** The device behind a cookie, if it is registered and not revoked. */
export async function resolveWardDevice(cookieValue: string | undefined): Promise<WardDevice | null> {
  const parsed = parseDeviceCookie(cookieValue);
  if (!parsed) return null;
  return withTenant(parsed.hospitalId, async (tx) => {
    const [device] = await tx
      .select({ id: wardDevices.id, hospitalId: wardDevices.hospitalId, branchId: wardDevices.branchId, label: wardDevices.label })
      .from(wardDevices)
      .where(and(eq(wardDevices.tokenHash, hashToken(parsed.token)), isNull(wardDevices.revokedAt)));
    if (!device) return null;
    await tx.update(wardDevices).set({ lastSeenAt: new Date() }).where(eq(wardDevices.id, device.id));
    return device;
  });
}

/**
 * "Who is recording?": active staff who may record and have set a PIN, in
 * the device's branch (or no particular branch). First names only would be
 * ambiguous on a ward with two Sunitas, so the full name is shown.
 */
export async function listPinPeople(device: WardDevice): Promise<{ userId: string; name: string }[]> {
  return withTenant(device.hospitalId, (tx) =>
    tx
      .select({ userId: users.id, name: users.name })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .where(
        and(
          eq(staffMemberships.active, true),
          eq(users.active, true),
          isNotNull(staffMemberships.pinHash),
          inArray(staffMemberships.role, RECORDING_ROLES),
          or(isNull(staffMemberships.branchId), eq(staffMemberships.branchId, device.branchId)),
        ),
      )
      .orderBy(asc(users.name)),
  );
}

/** A person sets (or changes) their own PIN, signed in with their own login. */
export async function setOwnPin(args: { hospitalId: string; userId: string; pin: string }): Promise<void> {
  const problem = pinProblem(args.pin);
  if (problem) throw new WardDeviceError(PIN_PROBLEM_MESSAGES[problem]);
  const pinHash = await hashPassword(args.pin);
  await withTenant(args.hospitalId, async (tx) => {
    const [row] = await tx
      .update(staffMemberships)
      .set({ pinHash })
      .where(eq(staffMemberships.userId, args.userId))
      .returning({ id: staffMemberships.id });
    if (!row) throw new WardDeviceError('Login not found');
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.userId,
      action: 'ipd.pin_set',
      objectType: 'user',
      objectId: args.userId,
    });
  });
}

export async function hasPin(hospitalId: string, userId: string): Promise<boolean> {
  const [row] = await withTenant(hospitalId, (tx) =>
    tx
      .select({ pinHash: staffMemberships.pinHash })
      .from(staffMemberships)
      .where(eq(staffMemberships.userId, userId)),
  );
  return Boolean(row?.pinHash);
}

/** The owner clears a forgotten PIN; the person sets a new one with their login. */
export async function clearPin(args: { hospitalId: string; userId: string; actorUserId: string }): Promise<void> {
  await withTenant(args.hospitalId, async (tx) => {
    await tx.update(staffMemberships).set({ pinHash: null }).where(eq(staffMemberships.userId, args.userId));
    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'ipd.pin_cleared',
      objectType: 'user',
      objectId: args.userId,
    });
  });
  // Any PIN session they hold ends too.
  await getDb()
    .delete(sessions)
    .where(and(eq(sessions.userId, args.userId), isNotNull(sessions.wardDeviceId)));
  invalidateSessionCache();
}

export type UnlockResult =
  | { ok: true; sessionToken: string }
  | { ok: false; error: string; lockedUntil?: Date };

/**
 * PIN → a 10-minute, nurse-only session on this device. Five wrong tries
 * lock this person on this device for fifteen minutes; the count resets on
 * a correct PIN. The check runs in constant time whether or not the person
 * has a PIN, so a timing difference does not reveal who has one.
 */
export async function unlockWithPin(args: {
  device: WardDevice;
  userId: string;
  pin: string;
  now?: Date;
}): Promise<UnlockResult> {
  const now = args.now ?? new Date();
  const { device } = args;

  const verdict = await withTenant(device.hospitalId, async (tx) => {
    const [member] = await tx
      .select({ pinHash: staffMemberships.pinHash, role: staffMemberships.role, branchId: staffMemberships.branchId })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .where(and(eq(staffMemberships.userId, args.userId), eq(staffMemberships.active, true), eq(users.active, true)));

    await tx
      .insert(wardDevicePinAttempts)
      .values({ hospitalId: device.hospitalId, deviceId: device.id, userId: args.userId })
      .onConflictDoNothing();
    const [attempts] = await tx
      .select()
      .from(wardDevicePinAttempts)
      .where(and(eq(wardDevicePinAttempts.deviceId, device.id), eq(wardDevicePinAttempts.userId, args.userId)))
      .for('update');
    if (isLocked(attempts.lockedUntil, now)) {
      return { ok: false as const, error: 'Too many wrong PINs. Try again in 15 minutes, or use your own login.', lockedUntil: attempts.lockedUntil! };
    }

    const DUMMY = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
    const allowed =
      member !== undefined &&
      can(member.role, 'ipd.record') &&
      (member.branchId === null || member.branchId === device.branchId);
    const correct = await verifyPassword(args.pin, member?.pinHash ?? DUMMY);
    if (allowed && member?.pinHash && correct) {
      await tx
        .update(wardDevicePinAttempts)
        .set({ failedCount: 0, lockedUntil: null, updatedAt: now })
        .where(eq(wardDevicePinAttempts.id, attempts.id));
      await tx.insert(auditLogs).values({
        hospitalId: device.hospitalId,
        actorUserId: args.userId,
        action: 'auth.ward_pin_login',
        objectType: 'ward_device',
        objectId: device.id,
      });
      return { ok: true as const };
    }

    const next = afterWrongPin(attempts.failedCount, now);
    await tx
      .update(wardDevicePinAttempts)
      .set({ failedCount: next.failedCount, lockedUntil: next.lockedUntil, updatedAt: now })
      .where(eq(wardDevicePinAttempts.id, attempts.id));
    return next.lockedUntil
      ? { ok: false as const, error: 'Too many wrong PINs. Try again in 15 minutes.', lockedUntil: next.lockedUntil }
      : { ok: false as const, error: 'Wrong PIN' };
  });
  if (!verdict.ok) return verdict;

  const token = WARD_TOKEN_PREFIX + generateSessionToken();
  await getDb().insert(sessions).values({
    userId: args.userId,
    hospitalId: device.hospitalId,
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + WARD_SESSION_IDLE_MS),
    wardDeviceId: device.id,
  });
  return { ok: true, sessionToken: token };
}

/** Everyone who may record, and whether they have a ward PIN, for Settings. */
export async function listPinStatus(hospitalId: string) {
  const rows = await withTenant(hospitalId, (tx) =>
    tx
      .select({
        userId: users.id,
        name: users.name,
        role: staffMemberships.role,
        hasPin: isNotNull(staffMemberships.pinHash),
      })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .where(and(eq(staffMemberships.active, true), inArray(staffMemberships.role, RECORDING_ROLES)))
      .orderBy(asc(users.name)),
  );
  return rows.map((row) => ({ ...row, hasPin: Boolean(row.hasPin) }));
}
