import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { getDb, withTenant, type Tx } from '@/lib/db';
import { markRequestReadOnly } from '@/lib/db/request-context';
import { auditLogs, branches, hospitals, sessions, staffMemberships, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/security/password';
import { generateSessionToken, hashToken } from '@/lib/security/tokens';
import { assertCanAdd } from './entitlements';

const SESSION_TTL_DAYS = 14;

export type StaffRole = 'owner' | 'receptionist' | 'doctor';

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
};

/** Impersonation is for looking at a problem, not for living in. */
export const IMPERSONATION_TTL_MINUTES = 30;

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
  // Enforce staff limits for new staff additions
  await assertCanAdd({ hospitalId: args.hospitalId, kind: 'staff' });

  const db = getDb();
  const rawPassword = args.password || 'Staff@123';
  const email = args.email.toLowerCase().trim();

  // Find existing user or insert
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email));

  if (!user) {
    [user] = await db
      .insert(users)
      .values({
        email,
        passwordHash: await hashPassword(rawPassword),
        name: args.name.trim(),
      })
      .returning();
  }

  // `users` has no RLS, but `staff_memberships` does — it is the row that binds
  // a person to a hospital, so it has to be written inside that tenant's scope.
  const [membership] = await withTenant(args.hospitalId, (tx) =>
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

  return { user, membership };
}

/**
 * Returns an opaque session token, or null. The caller is responsible for
 * putting it in an httpOnly cookie.
 *
 * The password is verified even when no user matches, so that a wrong email and
 * a wrong password take the same time and cannot be told apart.
 */
export async function login(email: string, password: string): Promise<string | null> {
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

// In-memory session cache (30s TTL) — avoids a DB roundtrip on every
// auto-refresh cycle. Cleared on logout.
type SessionCacheEntry = { session: Session; expiresAt: number };
const sessionCache = new Map<string, SessionCacheEntry>();
const SESSION_CACHE_TTL = 30_000;

export async function resolveSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;

  const tokenH = hashToken(token);

  const cached = sessionCache.get(tokenH);
  if (cached && cached.expiresAt > Date.now()) {
    // Re-marked on every resolve, cache hit included: the flag lives for one
    // request, the cached session for thirty seconds across many.
    if (cached.session.readOnly) markRequestReadOnly();
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
      hospitalId: sessions.hospitalId,
      impersonatedByUserId: sessions.impersonatedByUserId,
      readOnly: sessions.readOnly,
      returnHospitalId: sessions.returnHospitalId,
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
  if (row.readOnly) markRequestReadOnly();

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
            ? { ...found, role: 'owner' as StaffRole, branchId: null }
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
        return found ?? null;
      });

  // Membership revoked since the session was issued, or platform admin dropped.
  if (!context) return null;

  const session: Session = {
    userId: row.userId,
    name: row.name,
    email: row.email,
    isPlatformAdmin: row.isPlatformAdmin,
    hospitalId: row.hospitalId,
    hospitalName: context.hospitalName,
    timezone: context.timezone,
    role: context.role,
    branchId: context.branchId,
    readOnly: row.readOnly,
    impersonatedByUserId: row.impersonatedByUserId,
    returnHospitalId: row.returnHospitalId,
    mustChangePassword: row.mustChangePassword,
  };

  sessionCache.set(tokenH, { session, expiresAt: Date.now() + SESSION_CACHE_TTL });
  return session;
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
  await getDb().delete(sessions).where(eq(sessions.tokenHash, tokenH));
}

/** Reception and owners may move the queue; doctors may move their own. */
export const canMutateQueue = (role: StaffRole): boolean =>
  role === 'owner' || role === 'receptionist' || role === 'doctor';

export const canConfigureHospital = (role: StaffRole): boolean => role === 'owner';

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
  return withTenant(args.hospitalId, (tx) =>
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
}

