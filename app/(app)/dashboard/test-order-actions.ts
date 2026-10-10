'use server';

import { revalidatePath } from 'next/cache';
import { ModuleUnavailableError, assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { EncounterError } from '@/lib/services/encounters';
import { TestOrderError, cancelTestOrder, orderOpdTests } from '@/lib/services/test-orders';

/**
 * The doctor sends the patient in the room for tests (IPD sheets plan C4a).
 * Returns a result for a toast rather than redirecting, like the rest of the
 * consultation screen. Module `test_follow_up`, permission `tests.order`.
 */

type Result = { ok: true; message: string } | { ok: false; error: string };

const known = (err: unknown) => err instanceof TestOrderError || err instanceof EncounterError || err instanceof ModuleUnavailableError;

export async function orderOpdTestsDynamic(args: { appointmentId: string; chargeItemIds: string[]; formKey: string }): Promise<Result> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'tests.order')) return { ok: false, error: 'Only a doctor can send a patient for tests' };
    await assertModule(session, 'test_follow_up', 'write');
    const ordered = await orderOpdTests({
      hospitalId: session.hospitalId,
      appointmentId: args.appointmentId,
      chargeItemIds: args.chargeItemIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id)),
      formKey: args.formKey,
      actorUserId: session.userId,
      seeAll: session.role === 'owner',
    });
    revalidatePath('/dashboard');
    const fresh = ordered.filter((o) => !o.repeat).length;
    return { ok: true, message: fresh === 0 ? 'Already sent' : `Sent for ${ordered.map((o) => o.testName).join(', ')}` };
  } catch (err) {
    if (known(err)) return { ok: false, error: (err as Error).message };
    console.error('[tests] could not order', err);
    return { ok: false, error: 'Could not send for tests. Try again.' };
  }
}

export async function cancelOpdTestDynamic(args: { orderId: string }): Promise<Result> {
  try {
    const session = await requireWritableSession();
    if (!can(session.role, 'tests.order')) return { ok: false, error: 'Only a doctor can cancel a test' };
    await assertModule(session, 'test_follow_up', 'write');
    await cancelTestOrder({
      hospitalId: session.hospitalId,
      orderId: args.orderId,
      actorUserId: session.userId,
      isOwner: session.role === 'owner',
      reason: 'Ordered by mistake',
    });
    revalidatePath('/dashboard');
    return { ok: true, message: 'Test cancelled' };
  } catch (err) {
    if (known(err)) return { ok: false, error: (err as Error).message };
    console.error('[tests] could not cancel', err);
    return { ok: false, error: 'Could not cancel. Try again.' };
  }
}
