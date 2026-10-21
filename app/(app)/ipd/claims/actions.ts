'use server';

import { revalidatePath } from 'next/cache';
import { assertModule } from '@/lib/auth/modules';
import { requireWritableSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import {
  recordClaimQueryInTx,
  replyClaimQueryInTx,
  transitionClaimStatusInTx,
  upsertClaimDocumentRecordInTx,
} from '@/lib/services/claims';
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
    } else if (action === 'replyQuery') {
      await replyClaimQueryInTx(tx, {
        queryId: payload.queryId,
        hospitalId: session.hospitalId,
        replyNotes: payload.replyNotes,
        replyChannel: payload.replyChannel ?? 'portal',
        replyReference: payload.replyReference ?? null,
        actorUserId: session.userId,
      });
    } else if (action === 'updateCustodyRecord') {
      await upsertClaimDocumentRecordInTx(tx, {
        hospitalId: session.hospitalId,
        claimCaseId: payload.claimCaseId,
        docCategory: payload.docCategory,
        isPaperFiled: payload.isPaperFiled,
        physicalBoxOrFileNo: payload.physicalBoxOrFileNo ?? null,
        notes: payload.notes ?? null,
        actorUserId: session.userId,
        clientId: randomUUID(),
      });
    }
  });

  revalidatePath('/ipd/claims');
  if (payload.admissionId) {
    revalidatePath(`/ipd/admissions/${payload.admissionId}/claims`);
  }
}
