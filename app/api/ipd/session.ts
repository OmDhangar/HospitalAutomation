import { NextResponse } from 'next/server';
import { getSessionState, isPlanLocked } from '@/lib/auth/session';
import { can, type Permission } from '@/lib/domain/permissions';
import { getModuleStates } from '@/lib/services/modules';
import { moduleAllows, type ModuleId, type ModuleStates } from '@/lib/modules/registry';

/**
 * Who is calling an IPD route, as JSON rather than a redirect: these are
 * fetched by the nurse's phone, which needs a status code it can act on (go
 * to login, keep the entry in the outbox) instead of a login page as HTML.
 *
 * A route that belongs to a switchable module passes `module` (ADR-021): when
 * the module is off — or read-only and this is a write, or the ward is outside
 * its rollout — the answer is 404, as if the route did not exist.
 */
export async function ipdCaller(
  permission: Permission,
  options: { write?: boolean; module?: ModuleId; wardId?: string | null } = {},
): Promise<
  | { session: NonNullable<Awaited<ReturnType<typeof getSessionState>>>; states: ModuleStates | null }
  | { response: NextResponse }
> {
  const session = await getSessionState();
  if (!session) return { response: NextResponse.json({ error: 'Sign in again' }, { status: 401 }) };
  // Locked (idle or in the background): the phone keeps any queued entries and shows the unlock screen.
  if (session.locked) {
    return { response: NextResponse.json({ error: 'Locked', locked: true, channel: session.channel }, { status: 401 }) };
  }
  if (session.noticePending) {
    return { response: NextResponse.json({ error: 'Read and accept the staff notice first' }, { status: 403 }) };
  }
  if (options.write && (session.readOnly || session.mustChangePassword)) {
    return { response: NextResponse.json({ error: 'This login cannot record entries' }, { status: 403 }) };
  }
  if (await isPlanLocked(session)) {
    return { response: NextResponse.json({ error: 'This hospital’s QuriioHQ plan is not active' }, { status: 403 }) };
  }
  if (!can(session.role, permission)) {
    return { response: NextResponse.json({ error: 'Not allowed' }, { status: 403 }) };
  }
  // Handed back so a route can check each patient's ward against the rollout without a second read.
  let states: ModuleStates | null = null;
  if (options.module) {
    states = await getModuleStates(session.hospitalId);
    if (!moduleAllows(states, options.module, options.write ? 'write' : 'read', options.wardId ?? null)) {
      return { response: NextResponse.json({ error: 'Not available' }, { status: 404 }) };
    }
  }
  return { session, states };
}
