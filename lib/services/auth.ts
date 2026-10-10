import { and, asc, eq, gt, isNull, sql } from 'drizzle-orm';
import { getDb, withTenant, type Tx } from '@/lib/db';
import { markRequestOrigin, markRequestReadOnly, markRequestStaffUser } from '@/lib/db/request-context';
import {
  auditLogs,
  branches,
  hospitalFeatures,
  hospitals,
  policyAcknowledgements,
  sessions,
  staffMemberships,
  users,
  wardDevices,
} from '@/lib/db/schema';
import { MONITORING_NOTICE_KEY, MONITORING_NOTICE_VERSION } from '@/lib/domain/monitoring-notice';
import {
  channelAllowed,
  parseAccessSettings,
  sessionRule,
  sessionVerdict,
  shouldWriteLastSeen,
  wardRoleFor,
  type Channel,
} from '@/lib/domain/staff-access';
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  passwordProblem,
  unguessablePassword,
  verifyPassword,
} from '@/lib/security/password';
import { generateSessionToken, hashToken } from '@/lib/security/tokens';
import { can, type StaffRole } from '@/lib/domain/permissions';
import { assertCanAdd } from './entitlements';

const SESSION_TTL_DAYS = 14;

export type { StaffRole } from '@/lib/domain/permissions';

export type Session = {
  userId: string;
  name: string;
  email: string;
  isPlatformAdmin: boolean;
  hospitalId: string;
  hospitalName: string;
  timezone: string;
  role: StaffRole;
  branchId: string | null;
  /**
   * True only on an impersonated session. Carried here so the UI can hide the
   * controls it would be pointless to offer; the actual prohibition is a
   * restrictive row-level policy on every tenant table, because a guard the
   * interface enforces is a guard a direct POST skips.
   */
  readOnly: boolean;
  /** The operator behind an impersonated session, null on an ordinary login. */
  impersonatedByUserId: string | null;
  /** Where ending an impersonation returns that operator. */
  returnHospitalId: string | null;
  /** Set by an operator-issued password reset; gates the rest of the app. */
  mustChangePassword: boolean;
  /** The sessions row, for access logs and "sign out everywhere" (0042). */
  sessionId: string;
  /**
   * Own device, or a PIN on a shared ward tablet (ADR-022). On a ward tablet
   * `role` is capped by wardRoleFor (an owner acts as a doctor) and
   * `personRole` is the person's own role.
   */
  channel: Channel;
  personRole: StaffRole;
  wardDeviceId: string | null;
  deviceId: string | null;
  /**
   * Idle or backgrounded too long: the session is held but unusable until a
   * PIN or password unlock. getSession() treats it as signed out;
   * requireSession() sends it to the unlock screen.
   */
  locked: boolean;
  /** The hospital requires the monitoring notice and this person has not accepted the current version. */
  noticePending: boolean;
  /**
   * When the page itself should lock the screen (components/session-guard):
   * after this long without a tap, or this long in the background. Null where
   * the rule does not apply. The server enforces the same limits.
   */
  screenLock: { idleMs: number | null; backgroundMs: number | null };
};

/** Impersonation is for looking at a problem, not for living in. */
export const IMPERSONATION_TTL_MINUTES = 30;

export class StaffAccountError extends Error {
  constructor(
    readonly code: 'EMAIL_IN_USE' | 'WEAK_PASSWORD',
    message: string,
  ) {
    super(message);
    this.name = 'StaffAccountError';
  }
}

/**
 * Refuses an email that already has a login.
 *
 * Adding staff used to look the email up and, if a login existed, attach it
 * to the new hospital with its password unchanged. That made an account
 * claimable in advance: an owner at one hospital could create a login for an
 * email they expected another hospital to use, wait for it to be attached
 * there, deactivate it at their own hospital, and sign in — landing as staff
 * (or owner) of the other hospital, on a password they had chosen.
 *
 * A login therefore belongs to exactly one hospital, which is also all the
 * session model supports. Someone who genuinely works at two places uses two
 * email addresses.
 */
export async function assertEmailUnclaimed(
  db: { select: ReturnType<typeof getDb>['select'] },
  email: string,
): Promise<void> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()));
  if (existing) {
    throw new StaffAccountError(
      'EMAIL_IN_USE',
      'That email already has a login. Use a different email address.',
    );
  }
}

/**
 * `users` and `sessions` are the two tables without row-level security: a login
 * has to be resolvable before any hospital is known. Authorisation for them is
 * enforced here instead, which is why this module is the only place that
 * touches them.
 */
export async function createStaffUser(args: {
  email: string;
  password?: string;
  name: string;
  hospitalId: string;
  role: StaffRole;
  branchId?: string | null;
}) {
  const db = getDb();
  const email = args.email.toLowerCase().trim();

  /**
   * The password given here is someone else's to replace, never theirs to
   * keep: the person adding the account knows it. So it is always marked
   * must-change, and with none given the account gets one that nobody knows,
   * to be replaced through an operator-issued temporary password.
   *
   * There used to be a fixed default ("Staff@123") that was never forced to
   * change — a password anyone could guess for any account created without
   * one.
   */
  if (args.password !== undefined) {
    const problem = passwordProblem(args.password);
    if (problem) {
      throw new StaffAccountError(
        'WEAK_PASSWORD',
        problem === 'too_short'
          ? `Use a temporary password of at least ${MIN_PASSWORD_LENGTH} characters.`
          : 'That password was a public default. Choose another.',
      );
    }
  }

  await assertEmailUnclaimed(db, email);

  // Enforce staff limits for new staff additions
  await assertCanAdd({ hospitalId: args.hospitalId, kind: 'staff' });

  const [user] = await db
    .insert(users)
    .values({
      email,
      passwordHash: await hashPassword(args.password ?? unguessablePassword()),
      name: args.name.trim(),
      mustChangePassword: true,
    })
    .returning();

  // `users` has no RLS, but `staff_memberships` does — it is the row that binds
  // a person to a hospital, so it has to be written inside that tenant's scope.
  let membership;
  try {
    [membership] = await withTenant(args.hospitalId, (tx) =>
      tx
        .insert(staffMemberships)
        .values({
          userId: user.id,
          hospitalId: args.hospitalId,
          branchId: args.branchId ?? null,
          role: args.role,
          active: true,
        })
        .returning(),
    );
  } catch (error) {
    // Two connections, so not one transaction. Without this a failed
    // membership would leave a login with no hospital, and the email could
    // never be added again.
    await db.delete(users).where(eq(users.id, user.id));
    throw error;
  }

  return { user, membership };
}

/**
 * Returns an opaque session token, or null. The caller is responsible for
 * putting it in an httpOnly cookie.
 *
 * The password is verified even when no user matches, so that a wrong email and
 * a wrong password take the same time and cannot be told apart.
 */
export async function login(
  email: string,
  password: string,
  options: { deviceId?: string | null } = {},
): Promise<string | null> {
  const db = getDb();
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()));

  const DUMMY_HASH =
    'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);

  if (!user || !user.active || !ok) return null;

  /**
   * Which hospital this session is for. `staff_memberships` is RLS-protected,
   * so it cannot be read before a tenant context exists — this is the bootstrap
   * lookup that breaks that cycle. It returns a hospital id and nothing else;
   * every richer read below goes through withTenant.
   */
  const [membership] = await db.execute<{ hospital_id: string | null }>(
    sql`select public.resolve_user_hospital(${user.id}::uuid) as hospital_id`,
  );

  // A user with no active membership cannot sign in to anything.
  const hospitalId = membership?.hospital_id;
  if (!hospitalId) return null;

  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user.id,
    hospitalId,
    tokenHash: hashToken(token),
    expiresAt: new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000),
    channel: 'personal',
    deviceId: options.deviceId ?? null,
    lastSeenAt: new Date(),
  });

  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  // Written against the hospital rather than as a platform-level row, so an
  // owner reviewing access to their patients' data sees their staff's logins.
  await withTenant(hospitalId, (tx) =>
    tx.insert(auditLogs).values({
      hospitalId,
      actorUserId: user.id,
      action: 'auth.login',
      objectType: 'user',
      objectId: user.id,
    }),
  );

  return token;
}

// In-memory session cache: avoids a DB roundtrip on every auto-refresh cycle.
// Cleared on logout, lock and revocation in this process. A ward-tablet
// session is cached for only 10 s, so revoking a tablet takes effect quickly
// on every instance.
type SessionCacheEntry = { session: Session; expiresAt: number };
const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_CACHE_TTL = 30_000;
const WARD_SESSION_CACHE_TTL = 10_000;

export async function resolveSession(
  token: string | undefined,
  options: { fresh?: boolean } = {},
): Promise<Session | null> {
  if (!token) return null;

  const tokenH = hashToken(token);

  // `fresh`: this browser has just locked (lib/auth/session.ts), so the cache — which may sit in
  // another module instance or server — is not trusted until the lock is read from the database.
  const cached = options.fresh ? undefined : sessionCache.get(tokenH);
  if (cached && cached.expiresAt > Date.now()) {
    // Re-marked on every resolve, cache hit included: the flag lives for one
    // request, the cached session for thirty seconds across many.
    await markSessionOnRequest(cached.session);
    return cached.session;
  }

  const db = getDb();

  // Step one uses only the two tables without RLS, and yields the hospital id.
  const [row] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      isPlatformAdmin: users.isPlatformAdmin,
      active: users.active,
      mustChangePassword: users.mustChangePassword,
      sessionId: sessions.id,
      hospitalId: sessions.hospitalId,
      impersonatedByUserId: sessions.impersonatedByUserId,
      readOnly: sessions.readOnly,
      returnHospitalId: sessions.returnHospitalId,
      channel: sessions.channel,
      wardDeviceId: sessions.wardDeviceId,
      deviceId: sessions.deviceId,
      lastSeenAt: sessions.lastSeenAt,
      lockedAt: sessions.lockedAt,
      createdAt: sessions.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenH), gt(sessions.expiresAt, new Date())));

  if (!row || !row.active) return null;

  /**
   * An impersonating operator is marked before anything else reads the
   * database, so the very first tenant transaction of the request already
   * carries `app.read_only`.
   */
  if (row.readOnly) await markRequestReadOnly();

  const impersonating = row.impersonatedByUserId !== null;

  /**
   * Impersonation is the one case where the membership lookup below cannot
   * work: an operator has no staff row at the hospital they are looking into,
   * and giving them one would put them in that hospital's own staff list. The
   * authority comes from `is_platform_admin`, re-checked here rather than
   * trusted from the session row, so revoking it ends every support session in
   * flight at the next resolve.
   */
  const context = impersonating
    ? row.isPlatformAdmin
      ? await withTenant(row.hospitalId, async (tx) => {
          const [found] = await tx
            .select({ hospitalName: hospitals.name, timezone: hospitals.timezone })
            .from(hospitals)
            .where(eq(hospitals.id, row.hospitalId));
          return found
            ? {
                ...found,
                role: 'owner' as StaffRole,
                branchId: null,
                settings: parseAccessSettings(null),
                noticePending: false,
              }
            : null;
        })
      : null
    : await withTenant(row.hospitalId, async (tx) => {
        const [found] = await tx
          .select({
            role: staffMemberships.role,
            branchId: staffMemberships.branchId,
            hospitalName: hospitals.name,
            timezone: hospitals.timezone,
          })
          .from(staffMemberships)
          .innerJoin(hospitals, eq(hospitals.id, staffMemberships.hospitalId))
          .where(
            and(eq(staffMemberships.userId, row.userId), eq(staffMemberships.active, true)),
          );
        if (!found) return null;

        const [access] = await tx
          .select({ settings: hospitalFeatures.settings })
          .from(hospitalFeatures)
          .where(eq(hospitalFeatures.moduleId, 'staff_access'));
        const settings = parseAccessSettings(access?.settings);

        // A ward-tablet session lives only while its tablet is enrolled.
        let branchId = found.branchId;
        if (row.channel === 'ward_device') {
          if (!row.wardDeviceId) return null;
          const [device] = await tx
            .select({ branchId: wardDevices.branchId })
            .from(wardDevices)
            .where(and(eq(wardDevices.id, row.wardDeviceId), isNull(wardDevices.revokedAt)));
          if (!device) return null;
          branchId = device.branchId;
        }

        let noticePending = false;
        if (settings.monitoringNotice === 'required') {
          const [ack] = await tx
            .select({ id: policyAcknowledgements.id })
            .from(policyAcknowledgements)
            .where(
              and(
                eq(policyAcknowledgements.userId, row.userId),
                eq(policyAcknowledgements.policyKey, MONITORING_NOTICE_KEY),
                eq(policyAcknowledgements.policyVersion, MONITORING_NOTICE_VERSION),
              ),
            );
          noticePending = !ack;
        }
        return { ...found, branchId, settings, noticePending };
      });

  // Membership revoked since the session was issued, or platform admin dropped.
  if (!context) return null;

  /**
   * The access rules (ADR-022), on the server: a channel the hospital has
   * switched off for this role, or a session past its absolute limit or idle
   * too long, ends here; a clinical role idle too long is locked.
   * Impersonation has its own 30-minute limit and is left alone.
   */
  const channel = row.channel as Channel;
  let locked = row.lockedAt !== null;
  const rule = sessionRule(context.role, channel, context.settings);
  if (!impersonating) {
    const now = new Date();
    const verdict = channelAllowed(context.settings, context.role, channel)
      ? sessionVerdict({ createdAt: row.createdAt, lastSeenAt: row.lastSeenAt, lockedAt: row.lockedAt, now, rule })
      : 'end';
    if (verdict === 'end') {
      await db.delete(sessions).where(eq(sessions.id, row.sessionId));
      return null;
    }
    if (verdict === 'lock' && !locked) {
      locked = true;
      await db.update(sessions).set({ lockedAt: now }).where(eq(sessions.id, row.sessionId));
    } else if (verdict === 'active' && shouldWriteLastSeen(row.lastSeenAt, now, rule)) {
      await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId));
    }
  }

  const session: Session = {
    userId: row.userId,
    name: row.name,
    email: row.email,
    isPlatformAdmin: row.isPlatformAdmin,
    hospitalId: row.hospitalId,
    hospitalName: context.hospitalName,
    timezone: context.timezone,
    role: channel === 'ward_device' ? wardRoleFor(context.role) : context.role,
    branchId: context.branchId,
    readOnly: row.readOnly,
    impersonatedByUserId: row.impersonatedByUserId,
    returnHospitalId: row.returnHospitalId,
    mustChangePassword: row.mustChangePassword,
    sessionId: row.sessionId,
    channel,
    personRole: context.role,
    wardDeviceId: row.wardDeviceId,
    deviceId: row.deviceId,
    locked,
    noticePending: context.noticePending,
    // Screens lock themselves where the server would lock or end the session within the hour.
    screenLock: impersonating
      ? { idleMs: null, backgroundMs: null }
      : { idleMs: rule.idle.ms <= 60 * 60_000 ? rule.idle.ms : null, backgroundMs: rule.backgroundLockMs },
  };

  await markSessionOnRequest(session);

  sessionCache.set(tokenH, {
    session,
    expiresAt: Date.now() + (channel === 'ward_device' ? WARD_SESSION_CACHE_TTL : SESSION_CACHE_TTL),
  });
  return session;
}

/**
 * What the database and the access log need to know about this request: a
 * read-only support session, the real staff member (identity functions rely
 * on it), and the session, channel and device (written onto entries). A
 * locked session is marked as nobody.
 */
export async function markSessionOnRequest(session: Session): Promise<void> {
  if (session.readOnly) {
    await markRequestReadOnly();
    return;
  }
  if (session.impersonatedByUserId || session.locked) return;
  await markRequestStaffUser(session.userId);
  await markRequestOrigin({ sessionId: session.sessionId, channel: session.channel, deviceId: session.deviceId });
}

/** Drops a token from the 30-second cache so a change takes effect at once. */
export function invalidateSessionCache(token?: string) {
  if (token) sessionCache.delete(hashToken(token));
  else sessionCache.clear();
}

export async function logout(token: string | undefined) {
  if (!token) return;
  const tokenH = hashToken(token);
  sessionCache.delete(tokenH);
  const [ended] = await getDb()
    .delete(sessions)
    .where(eq(sessions.tokenHash, tokenH))
    .returning({
      userId: sessions.userId,
      hospitalId: sessions.hospitalId,
      channel: sessions.channel,
      impersonatedByUserId: sessions.impersonatedByUserId,
    });
  if (ended && !ended.impersonatedByUserId) {
    await withTenant(ended.hospitalId, (tx) =>
      tx.insert(auditLogs).values({
        hospitalId: ended.hospitalId,
        actorUserId: ended.userId,
        action: ended.channel === 'ward_device' ? 'auth.switch_user' : 'auth.logout',
        objectType: 'user',
        objectId: ended.userId,
      }),
    );
  }
}

/** Reception and owners may move the queue; doctors may move their own. */
export const canMutateQueue = (role: StaffRole): boolean => can(role, 'queue.mutate');

export const canConfigureHospital = (role: StaffRole): boolean => can(role, 'hospital.configure');

/** Branches are tenant data, so this read goes through the RLS-scoped path. */
export async function listBranches(hospitalId: string) {
  return withTenant(hospitalId, (tx) => listBranchesInTx(tx));
}

export async function listBranchesInTx(tx: Tx) {
  return tx
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(eq(branches.active, true));
}

export type StaffMemberItem = {
  id: string; // membership id
  userId: string;
  name: string;
  email: string;
  role: StaffRole;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  createdAt: Date;
};

export async function listStaffMembers(hospitalId: string): Promise<StaffMemberItem[]> {
  return withTenant(hospitalId, async (tx) => {
    const rows = await tx
      .select({
        id: staffMemberships.id,
        userId: staffMemberships.userId,
        name: users.name,
        email: users.email,
        role: staffMemberships.role,
        branchId: staffMemberships.branchId,
        branchName: branches.name,
        active: staffMemberships.active,
        createdAt: staffMemberships.createdAt,
      })
      .from(staffMemberships)
      .innerJoin(users, eq(users.id, staffMemberships.userId))
      .leftJoin(branches, eq(branches.id, staffMemberships.branchId))
      .where(eq(staffMemberships.hospitalId, hospitalId))
      .orderBy(asc(users.name));

    return rows;
  });
}

export async function setStaffActive(args: {
  hospitalId: string;
  membershipId: string;
  active: boolean;
}) {
  const result = await withTenant(args.hospitalId, (tx) =>
    tx
      .update(staffMemberships)
      .set({ active: args.active })
      .where(
        and(
          eq(staffMemberships.id, args.membershipId),
          eq(staffMemberships.hospitalId, args.hospitalId),
        ),
      ),
  );
  // Removing someone takes effect now: their sessions are deleted, so every
  // instance refuses the token, and this process's cache is cleared.
  if (!args.active) {
    const [membership] = await withTenant(args.hospitalId, (tx) =>
      tx
        .select({ userId: staffMemberships.userId })
        .from(staffMemberships)
        .where(eq(staffMemberships.id, args.membershipId)),
    );
    if (membership) {
      await getDb()
        .delete(sessions)
        .where(and(eq(sessions.userId, membership.userId), eq(sessions.hospitalId, args.hospitalId)));
    }
    invalidateSessionCache();
  }
  return result;
}

