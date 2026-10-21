import { notFound } from 'next/navigation';
import { requireModule } from '@/lib/auth/modules';
import { requireSession } from '@/lib/auth/session';
import { can } from '@/lib/domain/permissions';
import { withTenant } from '@/lib/db';
import { admissions, claimCases, patients, payerProfiles } from '@/lib/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { maskClaimFinancialsForRole } from '@/lib/services/claims-masking';
import { ClaimsKpiStrip } from '@/components/ipd/claims/claims-kpi-strip';
import { ClaimsTable, type ClaimRowView } from '@/components/ipd/claims/claims-table';
import { claimActionHandler } from './actions';

export const metadata = { title: 'Claims & TPA Desk · IPD' };

export default async function ClaimsDeskPage() {
  const session = await requireSession();
  await requireModule(session, 'claims_tracker');
  if (!can(session.role, 'claims.view')) notFound();

  let claimRows: ClaimRowView[] = [];

  try {
    claimRows = await withTenant(session.hospitalId, async (tx) => {
      const rows = await tx
        .select({
          id: claimCases.id,
          admissionId: claimCases.admissionId,
          ipdNumber: admissions.ipdNumber,
          patientName: patients.name,
          payerName: payerProfiles.name,
          claimType: claimCases.claimType,
          status: claimCases.status,
          version: claimCases.version,
          policyNumberMasked: claimCases.policyNumberMasked,
          memberIdMasked: claimCases.memberIdMasked,
          preauthAmountPaise: claimCases.preauthAmountPaise,
          approvedAmountPaise: claimCases.approvedAmountPaise,
          settledAmountPaise: claimCases.settledAmountPaise,
          preauthSlaDeadline: claimCases.preauthSlaDeadline,
        })
        .from(claimCases)
        .innerJoin(admissions, eq(claimCases.admissionId, admissions.id))
        .innerJoin(patients, eq(claimCases.patientId, patients.id))
        .innerJoin(payerProfiles, eq(claimCases.payerProfileId, payerProfiles.id))
        .where(and(eq(claimCases.hospitalId, session.hospitalId), isNull(claimCases.voidedAt)))
        .orderBy(desc(claimCases.createdAt));

      return rows.map((r) => {
        const masked = maskClaimFinancialsForRole(r, session.role);
        return {
          id: masked.id,
          admissionId: masked.admissionId,
          ipdNumber: masked.ipdNumber,
          patientName: masked.patientName,
          payerName: masked.payerName,
          claimType: masked.claimType,
          status: masked.status,
          version: masked.version,
          policyNumberMasked: masked.policyNumberMasked,
          memberIdMasked: masked.memberIdMasked,
          preauthAmountPaise: masked.preauthAmountPaise,
          approvedAmountPaise: masked.approvedAmountPaise,
          settledAmountPaise: masked.settledAmountPaise,
          preauthSlaDeadline: masked.preauthSlaDeadline ? masked.preauthSlaDeadline.toISOString() : null,
          canEdit: can(session.role, 'claims.edit'),
        };
      });
    });
  } catch (err) {
    // Graceful fallback when tables not yet populated or on migration-delayed environment
    claimRows = [];
  }

  const kpis = {
    activeCount: claimRows.filter((c) => c.status !== 'settled' && c.status !== 'closed_cancelled').length,
    pendingPreauthCount: claimRows.filter((c) => c.status === 'preauth_submitted').length,
    urgentQueriesCount: claimRows.filter((c) => c.status === 'query_raised').length,
    dischargeReadyCount: claimRows.filter((c) => c.status === 'claim_ready').length,
  };

  return (
    <div className="space-y-6 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-ink-900 tracking-tight">Claims & TPA Desk</h1>
          <p className="text-sm text-ink-600 mt-1">
            Pre-authorizations, query countdowns, and insurer settlement workflow.
          </p>
        </div>
      </div>

      <ClaimsKpiStrip kpis={kpis} />

      <ClaimsTable
        claims={claimRows}
        onAction={async (act, payload) => {
          'use server';
          await claimActionHandler(act, payload);
        }}
      />
    </div>
  );
}
