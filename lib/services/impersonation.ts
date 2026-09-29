import { and, eq, isNotNull } from 'drizzle-orm';
import { getAdminDb } from '@/lib/db/admin';
import { auditLogs, hospitals, sessions, users } from '@/lib/db/schema';
import { generateSessionToken, hashToken } from '@/lib/security/tokens';
import { IMPERSONATION_TTL_MINUTES, invalidateSessionCache } from './auth';

/**
 * Support access to a customer's account.
 *
 * Three things make this defensible rather than a back door, and all three are
 * enforced below rather than promised in a policy document:
 *
 *   - it cannot write. The session carries `read_only`, which becomes
 *     `app.read_only` on every tenant transaction, which a restrictive
 *     row-level policy on every tenant table tests. Not a UI convention;
 *     a direct POST to a server action fails at the database.
 *   - it expires in thirty minutes, so an abandoned tab is not standing access.
 *   - it is written to the *customer's* audit log, not ours, so the hospital
 *     whose patient data was opened is the one who can see that it was.
 *
 * Every function here runs on the admin connection, because it necessarily
 * writes rows in a hospital the operator does not belong to.
 */

export class ImpersonationError extends Error {
  constructor(
    readonly code:
      | 'NOT_PLATFORM_ADMIN'
      | 'HOSPITAL_NOT_FOUND'
      | 'NOT_IMPERSONATING'
      | 'NO_RETURN_HOSPITAL',
    message: string,
  ) {
    super(message);
    this.name = 'ImpersonationError';
  }
}

export type ImpersonationStart = {
  token: string;
  expiresAt: Date;
  hospitalName: string;
};

export async function startImpersonation(args: {
  operatorUserId: string;
  hospitalId: string;
  /** Where "stop" puts them back — the operator's own hospital. */
  returnHospitalId: string;
  reason: string;
}): Promise<ImpersonationStart> {
  const db = getAdminDb();

  /**
   * Re-read rather than trusting the caller's session. This function is one
   * import away from any future script, and "the caller checked" is not a
   * property the caller can be relied on to have.
   */
  const [operator] = await db
    .select({ id: users.id, name: users.name, isPlatformAdmin: users.isPlatformAdmin, active: users.active })
    .from(users)
    .where(eq(users.id, args.operatorUserId));

  if (!operator?.active || !operator.isPlatformAdmin) {
    throw new ImpersonationError('NOT_PLATFORM_ADMIN', 'Not a platform operator.');
  }

  const [hospital] = await db
    .select({ id: hospitals.id, name: hospitals.name })
    .from(hospitals)
    .where(eq(hospitals.id, args.hospitalId));

  if (!hospital) {
    throw new ImpersonationError('HOSPITAL_NOT_FOUND', 'No such hospital.');
  }

  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_MINUTES * 60 * 1000);

  await db.transaction(async (tx) => {
    /**
     * One live impersonation per operator. Opening a second would leave the
     * first as an orphaned write-capable-looking session in the list, and
     * there is no reason to be inside two hospitals at once.
     */
    await tx
      .delete(sessions)
      .where(eq(sessions.impersonatedByUserId, operator.id));

    await tx.insert(sessions).values({
      userId: operator.id,
      hospitalId: hospital.id,
      tokenHash: hashToken(token),
      expiresAt,
      impersonatedByUserId: operator.id,
      readOnly: true,
      returnHospitalId: args.returnHospitalId,
    });

    await tx.insert(auditLogs).values({
      hospitalId: hospital.id,
      actorUserId: operator.id,
      action: 'support.impersonation.start',
      objectType: 'hospital',
      objectId: hospital.id,
      metadata: {
        operatorName: operator.name,
        reason: args.reason,
        readOnly: true,
        expiresAt: expiresAt.toISOString(),
      },
    });
  });

  return { token, expiresAt, hospitalName: hospital.name };
}

/**
 * Ends support access and hands back an ordinary session for the operator's
 * own hospital.
 *
 * A fresh session rather than the one they had before: swapping the cookie on
 * the way in discarded that token, and minting a new one is both simpler and
 * one fewer live credential than keeping the old row parked.
 */
export async function endImpersonation(token: string): Promise<{ token: string }> {
  const db = getAdminDb();
  const tokenH = hashToken(token);

  const [current] = await db
    .select({
      id: sessions.id,
      userId: sessions.userId,
      hospitalId: sessions.hospitalId,
      returnHospitalId: sessions.returnHospitalId,
    })
    .from(sessions)
    .where(and(eq(sessions.tokenHash, tokenH), isNotNull(sessions.impersonatedByUserId)));

  if (!current) {
    throw new ImpersonationError('NOT_IMPERSONATING', 'This session is not an impersonation.');
  }
  if (!current.returnHospitalId) {
    throw new ImpersonationError('NO_RETURN_HOSPITAL', 'Nowhere to return to.');
  }

  const nextToken = generateSessionToken();

  await db.transaction(async (tx) => {
    await tx.delete(sessions).where(eq(sessions.id, current.id));

    await tx.insert(sessions).values({
      userId: current.userId,
      hospitalId: current.returnHospitalId!,
      tokenHash: hashToken(nextToken),
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    await tx.insert(auditLogs).values({
      hospitalId: current.hospitalId,
      actorUserId: current.userId,
      action: 'support.impersonation.end',
      objectType: 'hospital',
      objectId: current.hospitalId,
    });
  });

  invalidateSessionCache(token);
  return { token: nextToken };
}

export type ActiveImpersonation = {
  operatorName: string;
  operatorEmail: string;
  hospitalId: string;
  hospitalName: string;
  expiresAt: Date;
  startedAt: Date;
};

/** Who is inside a customer account right now. Shown on the console. */
export async function listActiveImpersonations(): Promise<ActiveImpersonation[]> {
  const rows = await getAdminDb()
    .select({
      operatorName: users.name,
      operatorEmail: users.email,
      hospitalId: hospitals.id,
      hospitalName: hospitals.name,
      expiresAt: sessions.expiresAt,
      startedAt: sessions.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(hospitals, eq(hospitals.id, sessions.hospitalId))
    .where(isNotNull(sessions.impersonatedByUserId));

  return rows.filter((row) => row.expiresAt > new Date());
}
