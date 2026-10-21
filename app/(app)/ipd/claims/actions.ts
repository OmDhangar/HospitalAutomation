'use server';

import { revalidatePath } from 'next/cache';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { recordClaimQueryInTx, transitionClaimStatusInTx } from '@/lib/services/claims';
import { randomUUID } from 'node:crypto';

export async function claimActionHandler(action: string, payload: Record<string, any>) {
  const session = await requireWritableSession();
  if (!can(session.role, 'claims.edit')) {
    throw new Error('Permission denied: requires claims.edit');
  }
  await assertModule(session, 'claims_tracker', 'write');

  await withTenant(session.hospitalId, async (tx) => {
    if (action === 'recordPreauthApproved') {
      await transitionClaimStatusInTx(tx, {
        claimId: payload.claimId,
        hospitalId: session.hospitalId,
        expectedVersion: payload.expectedVersion,
        targetStatus: 'preauth_approved',
        amountPaise: payload.amountPaise,
        notes: 'Pre-auth approved via Claims Desk',
        actorUserId: session.userId,
        clientId: randomUUID(),
      });
    } else if (action === 'logQuery') {
      await recordClaimQueryInTx(tx, {
        claimId: payload.claimId,
        hospitalId: session.hospitalId,
        queryCategory: payload.queryCategory,
        queryDescription: payload.queryDescription,
        slaMinutes: payload.slaMinutes,
        actorUserId: session.userId,
        clientId: randomUUID(),
      });
    }
  });

  revalidatePath('/ipd/claims');
}
