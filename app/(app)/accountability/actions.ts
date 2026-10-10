'use server';

import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { verifyEvidence } from '@/lib/services/evidence';

/**
 * "Check now" on the Accountability page: the whole log, every seal from the
 * first, read through the owner's own session (row-level security and the
 * clinical key), recorded and itself logged.
 */
export async function checkEvidenceAction(): Promise<void> {
  const session = await requireSession();
  if (!can(session.role, 'acct.view') || session.readOnly) redirect('/accountability');
  const result = await verifyEvidence({
    hospitalId: session.hospitalId,
    source: 'manual',
    reader: 'tenant',
    ranByUserId: session.userId,
    full: true,
  });
  redirect(`/accountability?checked=${result.ok ? 'ok' : 'failed'}`);
}
