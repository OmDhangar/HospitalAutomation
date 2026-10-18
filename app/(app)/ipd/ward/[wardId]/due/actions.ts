'use server';

import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { MarError } from '@/lib/domain/mar';
import { can } from '@/lib/domain/permissions';
import { acknowledgeEscalation, rateAlerts } from '@/lib/services/due';

/** The due board's own actions (IPD sheets plan B3b): acknowledge an escalation, rate the shift's alert volume. Module `mar`. */

type Result = { ok: true } | { ok: false; error: string };

async function guard() {
  const session = await requireWritableSession();
  if (!can(session.role, 'ipd.dueBoard')) throw new MarError('Your login cannot use the due board');
  await assertModule(session, 'mar', 'write');
  return session;
}

async function run(fn: () => Promise<void>): Promise<Result> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    if (err instanceof MarError) return { ok: false, error: err.message };
    console.error('[due] action failed', err);
    return { ok: false, error: 'Could not save. Try again.' };
  }
}

export async function acknowledgeDynamic(args: { escalationId: string }): Promise<Result> {
  return run(async () => {
    const session = await guard();
    await acknowledgeEscalation({ hospitalId: session.hospitalId, escalationId: args.escalationId, actorUserId: session.userId });
  });
}

export async function rateAlertsDynamic(args: { wardId: string; rating: string }): Promise<Result> {
  return run(async () => {
    const session = await guard();
    await rateAlerts({ hospitalId: session.hospitalId, wardId: args.wardId, userId: session.userId, rating: args.rating, timezone: session.timezone });
  });
}
