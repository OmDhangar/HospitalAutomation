import { NextResponse } from 'next/server';
import { getSession, isPlanLocked } from '@/lib/auth/session';
import { can, type Permission } from '@/lib/domain/permissions';

/**
 * Who is calling an IPD route, as JSON rather than a redirect: these are
 * fetched by the nurse's phone, which needs a status code it can act on (go
 * to login, keep the entry in the outbox) instead of a login page as HTML.
 */
export async function ipdCaller(
  permission: Permission,
  options: { write?: boolean } = {},
): Promise<{ session: NonNullable<Awaited<ReturnType<typeof getSession>>> } | { response: NextResponse }> {
  const session = await getSession();
  if (!session) return { response: NextResponse.json({ error: 'Sign in again' }, { status: 401 }) };
  if (options.write && (session.readOnly || session.mustChangePassword)) {
    return { response: NextResponse.json({ error: 'This login cannot record entries' }, { status: 403 }) };
  }
  if (await isPlanLocked(session)) {
    return { response: NextResponse.json({ error: 'This hospital’s QuriioHQ plan is not active' }, { status: 403 }) };
  }
  if (!can(session.role, permission)) {
    return { response: NextResponse.json({ error: 'Not allowed' }, { status: 403 }) };
  }
  return { session };
}
