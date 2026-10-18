'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { MarError } from '@/lib/domain/mar';
import { can } from '@/lib/domain/permissions';
import { decideWitnessRequest } from '@/lib/services/mar';

/**
 * Witness from one's own signed-in session (IPD sheets plan §7.2, D-WITNESS
 * (b)): approve or decline a dose someone asked you to witness. Module `mar`.
 */
export async function decideWitnessAction(form: FormData) {
  const session = await requireWritableSession();
  if (!can(session.role, 'ipd.witness')) throw new Error('Your login cannot witness doses');
  await assertModule(session, 'mar', 'write');
  const approve = String(form.get('decision')) === 'approve';
  let message = approve ? 'Witnessed' : 'Declined: the nurse will ask someone else';
  try {
    await decideWitnessRequest({
      hospitalId: session.hospitalId,
      requestId: String(form.get('requestId') ?? ''),
      userId: session.userId,
      approve,
      channel: session.channel,
      deviceId: session.deviceId,
      sessionId: session.sessionId,
    });
  } catch (err) {
    if (!(err instanceof MarError)) throw err;
    message = '';
    revalidatePath('/ipd/witness');
    redirect(`/ipd/witness?${new URLSearchParams({ error: err.message })}`);
  }
  revalidatePath('/ipd/witness');
  redirect(`/ipd/witness?${new URLSearchParams({ saved: message })}`);
}
