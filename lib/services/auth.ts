import { and, eq, gt, sql } from 'drizzle-orm';
import { getDb, withTenant } from '@/lib/db';
import { auditLogs, branches, hospitals, sessions, staffMemberships, users } from '@/lib/db/schema';
import { hashPassword, verifyPassword } from '@/lib/security/password';
import { generateSessionToken, hashToken } from '@/lib/security/tokens';

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
};

/**
 * `users` and `sessions` are the two tables without row-level security: a login
 * has to be resolvable before any hospital is known. Authorisation for them is
 * enforced here instead, which is why this module is the only place that
 * touches them.
 */
export async function createStaffUser(args: {
  email: string;
  password: string;
  name: string;
  hospitalId: string;
  role: StaffRole;
  branchId?: string | null;
}) {
  const db = getDb();
  const [user] = await db
    .insert(users)
    .values({
      email: args.email.toLowerCase().trim(),
      passwordHash: await hashPassword(args.password),
      name: args.name,
    })
    .returning();

  // `users` has no RLS, but `staff_memberships` does — it is the row that binds
  // a person to a hospital, so it has to be written inside that tenant's scope.
  await withTenant(args.hospitalId, (tx) =>
    tx.insert(staffMemberships).values({
      userId: user.id,
      hospitalId: args.hospitalId,
      branchId: args.branchId ?? null,
      role: args.role,
    }),
  );

  return user;
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

export async function resolveSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;

  const db = getDb();

  // Step one uses only the two tables without RLS, and yields the hospital id.
  const [row] = await db
    .select({
      userId: users.id,
      name: users.name,
      email: users.email,
      isPlatformAdmin: users.isPlatformAdmin,
      active: users.active,
      hospitalId: sessions.hospitalId,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())));

  if (!row || !row.active) return null;

  // Step two runs inside that hospital's scope, so RLS applies normally.
  const context = await withTenant(row.hospitalId, async (tx) => {
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

  // Membership revoked since the session was issued.
  if (!context) return null;

  return {
    userId: row.userId,
    name: row.name,
    email: row.email,
    isPlatformAdmin: row.isPlatformAdmin,
    hospitalId: row.hospitalId,
    hospitalName: context.hospitalName,
    timezone: context.timezone,
    role: context.role,
    branchId: context.branchId,
  };
}

export async function logout(token: string | undefined) {
  if (!token) return;
  await getDb().delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
}

/** Reception and owners may move the queue; doctors may move their own. */
export const canMutateQueue = (role: StaffRole): boolean =>
  role === 'owner' || role === 'receptionist' || role === 'doctor';

export const canConfigureHospital = (role: StaffRole): boolean => role === 'owner';

/** Branches are tenant data, so this read goes through the RLS-scoped path. */
export async function listBranches(hospitalId: string) {
  return withTenant(hospitalId, (tx) =>
    tx
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.active, true)),
  );
}
