'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { DepositAlertError, updateDepositAlertSettings } from '@/lib/services/deposit-alerts';

/** Deposit alert thresholds (B2, D-DEP): the owner's. */
export async function saveDepositAlertSettingsAction(form: FormData) {
  const session = await requireWritableSession();
  if (!can(session.role, 'ipd.configure')) redirect('/ipd/deposits?error=Only%20the%20owner%20sets%20this');
  await assertModule(session, 'deposit_alert', 'write');
  try {
    await updateDepositAlertSettings({
      hospitalId: session.hospitalId,
      usedPct: Number(form.get('usedPct')),
      balanceRupees: Number(String(form.get('balanceRupees') ?? '').replace(/[,\s₹]/g, '')),
      actorUserId: session.userId,
    });
  } catch (err) {
    if (err instanceof DepositAlertError) redirect(`/ipd/deposits?error=${encodeURIComponent(err.message)}`);
    throw err;
  }
  revalidatePath('/ipd/deposits');
  redirect('/ipd/deposits?saved=Saved');
}
