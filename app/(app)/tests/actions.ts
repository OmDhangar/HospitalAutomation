'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { CALL_OUTCOMES, TestOrderError, isCallOutcome } from '@/lib/domain/test-orders';
import { advanceTests, cancelTestOrder, recordCall } from '@/lib/services/test-orders';

/**
 * The lab's worklist (IPD sheets plan C4a): record a call and what the patient
 * said, mark arrival, the test done, the report added. Anyone with
 * `tests.work` may post; the service checks they are on that lab's staff (the
 * owner works every list). Module `test_follow_up`.
 */

async function authorize() {
  const session = await requireWritableSession();
  if (!can(session.role, 'tests.work')) throw new Error('You cannot work a test list');
  await assertModule(session, 'test_follow_up', 'write');
  return session;
}

const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const ids = (form: FormData) => form.getAll('orderId').map(String).filter((id) => /^[0-9a-f-]{36}$/i.test(id));

const back = (pointId: string, params: Record<string, string>): never => {
  const path = `/tests/${pointId}`;
  revalidatePath(path);
  redirect(`${path}?${new URLSearchParams(params).toString()}`);
};

export async function recordCallAction(form: FormData) {
  const session = await authorize();
  const pointId = text(form, 'servicePointId');
  const outcome = text(form, 'outcome');
  if (!isCallOutcome(outcome)) back(pointId, { error: 'Choose what the patient said' });
  const clientId = text(form, 'clientId');
  try {
    const { recorded, closed } = await recordCall({
      hospitalId: session.hospitalId,
      servicePointId: pointId,
      orderIds: ids(form),
      outcome: outcome as keyof typeof CALL_OUTCOMES,
      note: text(form, 'note') || null,
      clientId: /^[0-9a-f-]{36}$/i.test(clientId) ? clientId : crypto.randomUUID(),
      userId: session.userId,
      isOwner: session.role === 'owner',
    });
    back(pointId, {
      saved:
        recorded === 0
          ? 'Already recorded, or the patient has arrived.'
          : closed > 0
            ? `Call recorded: ${CALL_OUTCOMES[outcome as keyof typeof CALL_OUTCOMES].toLowerCase()}. The test is closed as not coming.`
            : `Call recorded: ${CALL_OUTCOMES[outcome as keyof typeof CALL_OUTCOMES].toLowerCase()}.`,
    });
  } catch (err) {
    if (err instanceof TestOrderError) back(pointId, { error: err.message });
    throw err;
  }
}

const STEP_TEXT = { arrived: 'Marked arrived', done: 'Marked test done', reported: 'Report added' } as const;

export async function advanceTestsAction(form: FormData) {
  const session = await authorize();
  const pointId = text(form, 'servicePointId');
  const to = text(form, 'to');
  if (to !== 'arrived' && to !== 'done' && to !== 'reported') back(pointId, { error: 'Choose a step' });
  try {
    const moved = await advanceTests({
      hospitalId: session.hospitalId,
      servicePointId: pointId,
      orderIds: ids(form),
      to: to as 'arrived' | 'done' | 'reported',
      userId: session.userId,
      isOwner: session.role === 'owner',
    });
    back(pointId, { saved: moved === 0 ? 'Already done.' : `${STEP_TEXT[to as keyof typeof STEP_TEXT]}: ${text(form, 'patientName')}` });
  } catch (err) {
    if (err instanceof TestOrderError) back(pointId, { error: err.message });
    throw err;
  }
}

/** The ordering doctor or the owner cancels a test ordered by mistake (from the Today screen). */
export async function cancelTestAction(form: FormData) {
  const session = await requireWritableSession();
  if (!can(session.role, 'tests.order')) throw new Error('Only the doctor who ordered a test can cancel it');
  await assertModule(session, 'test_follow_up', 'write');
  const back = text(form, 'back') === 'today' ? '/tests/today' : '/tests';
  try {
    await cancelTestOrder({
      hospitalId: session.hospitalId,
      orderId: text(form, 'orderId'),
      actorUserId: session.userId,
      isOwner: session.role === 'owner',
      reason: text(form, 'reason'),
    });
  } catch (err) {
    if (err instanceof TestOrderError) {
      revalidatePath(back);
      redirect(`${back}?${new URLSearchParams({ error: err.message })}`);
    }
    throw err;
  }
  revalidatePath(back);
  redirect(`${back}?${new URLSearchParams({ saved: 'Test cancelled' })}`);
}
