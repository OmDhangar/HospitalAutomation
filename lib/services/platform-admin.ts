import { randomInt } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, hospitals, sessions, staffMemberships, users } from '@/lib/db/schema';
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  verifyPassword,
} from '@/lib/security/password';
import { invalidateSessionCache } from './auth';

/**
 * The levers an operator pulls on somebody else's account.
 *
 * Every one of these writes on the admin connection, because by definition it
 * acts on a hospital the operator is not a member of. Two rules hold
 * throughout:
 *
 *   - anything that changes who can get in ends their sessions immediately.
 *     A deactivation that leaves a live cookie working for the next fortnight
 *     is not a deactivation.
 *   - everything is written to the *customer's* audit log. The hospital whose
 *     account we reached into is the one entitled to see that we did.
 */

export class AccountAdminError extends Error {
  constructor(
    readonly code:
      | 'HOSPITAL_NOT_FOUND'
      | 'USER_NOT_FOUND'
      | 'MEMBERSHIP_NOT_FOUND'
      | 'LAST_OWNER'
      | 'WEAK_PASSWORD'
      | 'WRONG_PASSWORD'
      | 'REASON_REQUIRED',
    message: string,
  ) {
    super(message);
    this.name = 'AccountAdminError';
  }
}

/**
 * A temporary password that can be read down a phone line without ambiguity.
 *
 * No I/l/1/O/0, because the entire point is that somebody reads it aloud to a
 * hospital receptionist and it works the first time. Length carries the entropy
 * instead: 12 characters from a 55-symbol alphabet is about 69 bits, and the
 * credential is single-use — `must_change_password` is set alongside it.
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export function generateTemporaryPassword(length = 12): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += PASSWORD_ALPHABET[randomInt(PASSWORD_ALPHABET.length)];
  }
  return out;
}

/** Ends every live session for a user, everywhere. */
async function revokeSessions(userId: string) {
  await getAdminDb().delete(sessions).where(eq(sessions.userId, userId));
  /**
   * The resolver caches sessions for thirty seconds. Without this, a revoked
   * login keeps working for up to half a minute — short, but exactly the half
   * minute during which somebody is being locked out on purpose.
   */
  invalidateSessionCache();
}

/* -------------------------------------------------------------- hospital */

/**
 * Turns a whole account on or off.
 *
 * `hospitals.active` is the harder of the two suspension levers: it hides the
 * hospital from the portfolio and from onboarding lists. The subscription
 * status is the commercial one. They are kept separate because "we switched
 * them off" and "they stopped paying" are different facts, and collapsing them
 * loses the ability to say which happened.
 */
export async function setHospitalActive(args: {
  hospitalId: string;
  active: boolean;
  reason: string;
  actorUserId: string;
}) {
  if (!args.reason.trim()) {
    throw new AccountAdminError('REASON_REQUIRED', 'Say why. It goes in the audit log.');
  }

  const db = getAdminDb();

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(hospitals)
      .set({ active: args.active, updatedAt: new Date() })
      .where(eq(hospitals.id, args.hospitalId))
      .returning({ id: hospitals.id, name: hospitals.name });

    if (!updated) {
      throw new AccountAdminError('HOSPITAL_NOT_FOUND', 'No such hospital.');
    }

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active ? 'platform.hospital.activate' : 'platform.hospital.suspend',
      objectType: 'hospital',
      objectId: args.hospitalId,
      metadata: { reason: args.reason.trim() },
    });

    return updated;
  });
}

export async function updateHospitalProfile(args: {
  hospitalId: string;
  name?: string;
  ownerPhoneE164?: string | null;
  timezone?: string;
  discountPercent?: number;
  actorUserId: string;
}) {
  const db = getAdminDb();
  const patch: Record<string, unknown> = { updatedAt: new Date() };

  if (args.name?.trim()) patch.name = args.name.trim();
  if (args.timezone?.trim()) patch.timezone = args.timezone.trim();
  if (args.ownerPhoneE164 !== undefined) {
    patch.ownerPhoneE164 = args.ownerPhoneE164?.trim() || null;
  }
  if (args.discountPercent !== undefined) {
    patch.discountPercent = Math.min(100, Math.max(0, Math.round(args.discountPercent)));
  }

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(hospitals)
      .set(patch)
      .where(eq(hospitals.id, args.hospitalId))
      .returning({ id: hospitals.id, name: hospitals.name });

    if (!updated) {
      throw new AccountAdminError('HOSPITAL_NOT_FOUND', 'No such hospital.');
    }

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'platform.hospital.update',
      objectType: 'hospital',
      objectId: args.hospitalId,
      // The patch, not the whole row: an audit entry is more useful when it
      // says what changed than when it restates everything that did not.
      metadata: { changed: Object.keys(patch).filter((key) => key !== 'updatedAt') },
    });

    return updated;
  });
}

/* ------------------------------------------------------------------ users */

export type PasswordReset = { email: string; temporaryPassword: string };

/**
 * Issues a replacement password for a hospital user who cannot get in.
 *
 * The new credential is returned to the operator once and never stored in
 * readable form. `must_change_password` is set with it, so what the operator
 * knows stops working the moment the customer signs in — an operator-issued
 * password that stays valid is a permanent second key to the account.
 */
export async function resetUserPassword(args: {
  userId: string;
  hospitalId: string;
  actorUserId: string;
  reason: string;
}): Promise<PasswordReset> {
  if (!args.reason.trim()) {
    throw new AccountAdminError('REASON_REQUIRED', 'Say why. It goes in the audit log.');
  }

  const db = getAdminDb();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);

  const email = await db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ id: staffMemberships.id })
      .from(staffMemberships)
      .where(
        and(
          eq(staffMemberships.userId, args.userId),
          eq(staffMemberships.hospitalId, args.hospitalId),
        ),
      );

    /**
     * Scoped to the hospital being administered rather than accepting any user
     * id. Without this, one crafted form field turns the console into a way to
     * reset a password for a user the operator was not looking at — including
     * another operator's.
     */
    if (!membership) {
      throw new AccountAdminError('MEMBERSHIP_NOT_FOUND', 'That user is not at this hospital.');
    }

    const [updated] = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true })
      .where(eq(users.id, args.userId))
      .returning({ email: users.email });

    if (!updated) throw new AccountAdminError('USER_NOT_FOUND', 'No such user.');

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: 'platform.user.password_reset',
      objectType: 'user',
      objectId: args.userId,
      metadata: { reason: args.reason.trim(), email: updated.email },
    });

    return updated.email;
  });

  await revokeSessions(args.userId);
  return { email, temporaryPassword };
}

/** Switches a login off platform-wide, or back on. */
export async function setUserActive(args: {
  userId: string;
  hospitalId: string;
  active: boolean;
  actorUserId: string;
}) {
  const db = getAdminDb();

  const result = await db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ id: staffMemberships.id, role: staffMemberships.role })
      .from(staffMemberships)
      .where(
        and(
          eq(staffMemberships.userId, args.userId),
          eq(staffMemberships.hospitalId, args.hospitalId),
        ),
      );

    if (!membership) {
      throw new AccountAdminError('MEMBERSHIP_NOT_FOUND', 'That user is not at this hospital.');
    }

    if (!args.active) await assertNotLastOwner(tx, args.hospitalId, args.userId);

    const [updated] = await tx
      .update(users)
      .set({ active: args.active })
      .where(eq(users.id, args.userId))
      .returning({ email: users.email });

    if (!updated) throw new AccountAdminError('USER_NOT_FOUND', 'No such user.');

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active ? 'platform.user.activate' : 'platform.user.deactivate',
      objectType: 'user',
      objectId: args.userId,
      metadata: { email: updated.email },
    });

    return updated;
  });

  if (!args.active) await revokeSessions(args.userId);
  return result;
}

/**
 * Revokes one hospital's access without touching the login itself.
 *
 * The distinction matters for anyone who works at two hospitals: ending their
 * membership at one must not lock them out of the other.
 */
export async function setMembershipActive(args: {
  membershipId: string;
  hospitalId: string;
  active: boolean;
  actorUserId: string;
}) {
  const db = getAdminDb();

  const result = await db.transaction(async (tx) => {
    const [membership] = await tx
      .select({ userId: staffMemberships.userId, role: staffMemberships.role })
      .from(staffMemberships)
      .where(
        and(
          eq(staffMemberships.id, args.membershipId),
          eq(staffMemberships.hospitalId, args.hospitalId),
        ),
      );

    if (!membership) {
      throw new AccountAdminError('MEMBERSHIP_NOT_FOUND', 'No such membership here.');
    }

    if (!args.active) await assertNotLastOwner(tx, args.hospitalId, membership.userId);

    await tx
      .update(staffMemberships)
      .set({ active: args.active })
      .where(eq(staffMemberships.id, args.membershipId));

    await tx.insert(auditLogs).values({
      hospitalId: args.hospitalId,
      actorUserId: args.actorUserId,
      action: args.active
        ? 'platform.membership.activate'
        : 'platform.membership.deactivate',
      objectType: 'staff_membership',
      objectId: args.membershipId,
      metadata: { role: membership.role },
    });

    return membership;
  });

  if (!args.active) await revokeSessions(result.userId);
  return result;
}

/**
 * A hospital with no owner cannot manage its own staff, billing or settings —
 * it can only be repaired from here, by us. Refusing the last one is cheaper
 * than the support call that follows allowing it.
 */
async function assertNotLastOwner(
  tx: Parameters<Parameters<ReturnType<typeof getAdminDb>['transaction']>[0]>[0],
  hospitalId: string,
  userId: string,
) {
  const owners = await tx
    .select({ userId: staffMemberships.userId })
    .from(staffMemberships)
    .innerJoin(users, eq(users.id, staffMemberships.userId))
    .where(
      and(
        eq(staffMemberships.hospitalId, hospitalId),
        eq(staffMemberships.role, 'owner'),
        eq(staffMemberships.active, true),
        eq(users.active, true),
      ),
    );

  const remaining = owners.filter((owner) => owner.userId !== userId);
  if (owners.some((owner) => owner.userId === userId) && remaining.length === 0) {
    throw new AccountAdminError(
      'LAST_OWNER',
      'This is the only active owner. Add another before removing this one.',
    );
  }
}

/* ----------------------------------------------------- self-service reset */

/**
 * The other half of `resetUserPassword`: the customer choosing their own.
 *
 * Clearing the flag is the point — it is what makes the operator-issued
 * password expire in practice rather than in principle.
 *
 * Also the everyday "change my password", which did not exist before: a user
 * could only ever replace a password an operator had just reset. Outside that
 * forced case `currentPassword` is required and checked, so a session left
 * open on a reception PC cannot be used to lock its owner out.
 */
export async function changeOwnPassword(args: {
  userId: string;
  newPassword: string;
  /** Required unless the account is in its forced-change state. */
  currentPassword?: string;
}): Promise<void> {
  const problem = passwordProblem(args.newPassword);
  if (problem) {
    throw new AccountAdminError(
      'WEAK_PASSWORD',
      problem === 'too_short'
        ? `Use at least ${MIN_PASSWORD_LENGTH} characters.`
        : 'That password was a public default. Choose another.',
    );
  }

  const [user] = await getAdminDb()
    .select({ passwordHash: users.passwordHash, mustChangePassword: users.mustChangePassword })
    .from(users)
    .where(eq(users.id, args.userId));
  if (!user) throw new AccountAdminError('USER_NOT_FOUND', 'No such user.');

  if (!user.mustChangePassword) {
    const ok =
      args.currentPassword !== undefined &&
      (await verifyPassword(args.currentPassword, user.passwordHash));
    if (!ok) {
      throw new AccountAdminError('WRONG_PASSWORD', 'Your current password is not correct.');
    }
  }

  await getAdminDb()
    .update(users)
    .set({
      passwordHash: await hashPassword(args.newPassword),
      mustChangePassword: false,
    })
    .where(eq(users.id, args.userId));

  await revokeSessions(args.userId);
}
