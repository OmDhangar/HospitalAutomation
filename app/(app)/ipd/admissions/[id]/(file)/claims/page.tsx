import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { moduleAllows } from '@/lib/modules/registry';
import {
  getClaimCaseByAdmissionId,
  listClaimDocumentsForCase,
  listClaimEventsForCase,
  listClaimQueriesForCase,
} from '@/lib/services/claims';
import { maskClaimIdentifier } from '@/lib/security/claims-encryption';
import { loadAdmission } from '../data';
import { ClaimCustodyChecklist } from '@/components/ipd/claims/claim-custody-checklist';
import { ClaimDetailsView } from '@/components/ipd/claims/claim-details-view';

export const metadata = { title: 'Insurance & Claims · IPD' };

export default async function AdmissionClaimsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requireSession();
  const states = await requireModule(session, 'claims_tracker');

  if (!can(session.role, 'claims.view')) {
    notFound();
  }

  const { id } = await params;
  const admission = await loadAdmission(session.hospitalId, id);
  if (!admission) notFound();

  const canEdit =
    !session.readOnly &&
    can(session.role, 'claims.edit') &&
    moduleAllows(states, 'claims_tracker', 'write');

  const { claim, events, queries, documents } = await withTenant(session.hospitalId, async (tx) => {
    const claimRow = await getClaimCaseByAdmissionId(tx, {
      hospitalId: session.hospitalId,
      admissionId: id,
      role: session.role,
    });

    if (!claimRow) {
      return { claim: null, events: [], queries: [], documents: [] };
    }

    const [eventsList, queriesList, docsList] = await Promise.all([
      listClaimEventsForCase(tx, { hospitalId: session.hospitalId, claimCaseId: claimRow.id }),
      listClaimQueriesForCase(tx, { hospitalId: session.hospitalId, claimCaseId: claimRow.id }),
      listClaimDocumentsForCase(tx, { hospitalId: session.hospitalId, claimCaseId: claimRow.id }),
    ]);

    return {
      claim: claimRow,
      events: eventsList,
      queries: queriesList,
      documents: docsList,
    };
  });

  if (!claim) {
    return (
      <div className="rounded-xl border border-dashed border-ink-300 bg-ink-50/50 p-8 text-center">
        <h3 className="text-sm font-semibold text-ink-800">No Insurance Claim Linked</h3>
        <p className="mt-1 text-xs text-ink-500 max-w-sm mx-auto">
          This inpatient admission does not currently have an active insurance or TPA claim case initiated.
        </p>
      </div>
    );
  }

  const isNurse = session.role === 'nurse';

  return (
    <div className="space-y-6">
      <ClaimDetailsView
        claim={{
          id: claim.id,
          admissionId: id,
          claimType: claim.claimType,
          status: claim.status,
          priority: claim.priority,
          maskedPolicyNumber: maskClaimIdentifier(claim.policyNumberBidx ? 'XXXXXXXXXXXX' : 'NOT_SET'),
          maskedMemberId: claim.memberIdBidx ? maskClaimIdentifier('XXXXXXXXXXXX') : null,
          preauthApprovedAmountPaise: claim.approvedAmountPaise,
          settledAmountPaise: claim.settledAmountPaise,
          deductionAmountPaise: claim.deductionAmountPaise,
          coPayAmountPaise: claim.coPayAmountPaise,
          version: claim.version,
          createdAt: claim.createdAt.toISOString(),
          updatedAt: claim.updatedAt.toISOString(),
        }}
        events={events.map((e) => ({
          ...e,
          createdAt: e.createdAt.toISOString(),
        }))}
        queries={queries.map((q) => ({
          ...q,
          receivedAt: q.receivedAt.toISOString(),
          slaDeadlineAt: q.slaDeadlineAt.toISOString(),
          repliedAt: q.repliedAt ? q.repliedAt.toISOString() : null,
        }))}
        canEdit={canEdit}
        isNurse={isNurse}
      />

      <ClaimCustodyChecklist
        claimCaseId={claim.id}
        admissionId={id}
        records={documents.map((d) => ({
          docCategory: d.docCategory,
          isPaperFiled: d.isPaperFiled,
          paperFiledAt: d.paperFiledAt ? d.paperFiledAt.toISOString() : null,
          physicalBoxOrFileNo: d.physicalBoxOrFileNo,
          notes: d.notes,
        }))}
        canEdit={canEdit}
      />
    </div>
  );
}
