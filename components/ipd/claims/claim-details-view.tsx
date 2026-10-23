'use client';

import { useState } from 'react';
import type { ClaimStatus } from '@/lib/domain/claims';
import { claimActionHandler } from '@/app/(app)/ipd/claims/actions';
import { LogQueryModal, RecordPreauthModal } from './claim-action-modals';

export interface ClaimDetailsProps {
  claim: {
    id: string;
    admissionId: string;
    payerName?: string;
    payerCode?: string;
    claimType: 'cashless' | 'reimbursement';
    status: ClaimStatus;
    priority: 'standard' | 'urgent' | 'emergency';
    maskedPolicyNumber: string;
    maskedMemberId: string | null;
    preauthApprovedAmountPaise: number | null;
    settledAmountPaise: number | null;
    deductionAmountPaise: number | null;
    coPayAmountPaise: number | null;
    version: number;
    createdAt: Date | string;
    updatedAt: Date | string;
  };
  events: Array<{
    id: string;
    eventType: string;
    previousStatus: string | null;
    newStatus: string;
    amountPaise: number | null;
    submissionChannel: string | null;
    externalReference: string | null;
    notes: string | null;
    createdAt: Date | string;
  }>;
  queries: Array<{
    id: string;
    queryCategory: string;
    queryDescription: string;
    receivedAt: Date | string;
    slaDeadlineAt: Date | string;
    status: string;
    replyNotes: string | null;
    repliedAt: Date | string | null;
  }>;
  canEdit: boolean;
  isNurse: boolean;
}

const STATUS_CONFIG: Record<ClaimStatus, { label: string; bg: string; text: string }> = {
  draft: { label: 'Draft', bg: 'bg-ink-100', text: 'text-ink-700' },
  preauth_submitted: { label: 'Pre-auth Submitted', bg: 'bg-amber-100', text: 'text-amber-800' },
  query_raised: { label: 'Query Raised', bg: 'bg-orange-100', text: 'text-orange-800' },
  preauth_approved: { label: 'Pre-auth Approved', bg: 'bg-emerald-100', text: 'text-emerald-800' },
  preauth_rejected: { label: 'Pre-auth Rejected', bg: 'bg-rose-100', text: 'text-rose-800' },
  enhancement_requested: { label: 'Enhancement Requested', bg: 'bg-indigo-100', text: 'text-indigo-800' },
  claim_ready: { label: 'Claim Ready', bg: 'bg-blue-100', text: 'text-blue-800' },
  final_submitted: { label: 'Final Claim Submitted', bg: 'bg-cyan-100', text: 'text-cyan-800' },
  settled: { label: 'Settled', bg: 'bg-green-100', text: 'text-green-800' },
  partially_settled: { label: 'Partially Settled', bg: 'bg-lime-100', text: 'text-lime-800' },
  claim_rejected: { label: 'Claim Rejected', bg: 'bg-rose-100', text: 'text-rose-800' },
  appeal_in_progress: { label: 'Appeal In Progress', bg: 'bg-purple-100', text: 'text-purple-800' },
  appeal_submitted: { label: 'Appeal Submitted', bg: 'bg-violet-100', text: 'text-violet-800' },
  appeal_won: { label: 'Appeal Won', bg: 'bg-emerald-100', text: 'text-emerald-800' },
  appeal_lost: { label: 'Appeal Lost', bg: 'bg-ink-200', text: 'text-ink-700' },
  reimbursement_draft: { label: 'Reimbursement Draft', bg: 'bg-ink-100', text: 'text-ink-700' },
  reimbursement_docs_gathering: { label: 'Gathering Documents', bg: 'bg-amber-100', text: 'text-amber-800' },
  reimbursement_dossier_ready: { label: 'Dossier Ready', bg: 'bg-teal-100', text: 'text-teal-800' },
  dossier_handed_to_patient: { label: 'Dossier Handed to Patient', bg: 'bg-blue-100', text: 'text-blue-800' },
  closed_settled: { label: 'Closed (Settled)', bg: 'bg-emerald-100', text: 'text-emerald-800' },
  closed_cancelled: { label: 'Closed / Cancelled', bg: 'bg-ink-200', text: 'text-ink-600' },
};

export function ClaimDetailsView({ claim, events, queries, canEdit, isNurse }: ClaimDetailsProps) {
  const [selectedClaimForQuery, setSelectedClaimForQuery] = useState<typeof claim | null>(null);
  const [selectedClaimForApproval, setSelectedClaimForApproval] = useState<typeof claim | null>(null);

  const statusStyle = STATUS_CONFIG[claim.status] || {
    label: claim.status,
    bg: 'bg-ink-100',
    text: 'text-ink-700',
  };

  const formatPaise = (paise: number | null) => {
    if (paise === null) {
      return isNurse ? '🔒 Confidential' : '₹0';
    }
    return `₹${(paise / 100).toLocaleString('en-IN')}`;
  };

  return (
    <div className="space-y-6">
      {/* Overview Card */}
      <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-ink-100 pb-4">
          <div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusStyle.bg} ${statusStyle.text}`}>
                {statusStyle.label}
              </span>
              <span className="text-xs font-mono uppercase bg-ink-100 text-ink-700 px-2 py-0.5 rounded">
                {claim.claimType}
              </span>
              {claim.priority !== 'standard' && (
                <span className="text-xs uppercase bg-rose-100 text-rose-800 px-2 py-0.5 rounded font-bold">
                  {claim.priority}
                </span>
              )}
            </div>
            <h2 className="text-lg font-bold text-ink-900 mt-1">
              {claim.payerName || 'Platform Payer'} {claim.payerCode ? `(${claim.payerCode})` : ''}
            </h2>
          </div>

          {canEdit && (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setSelectedClaimForQuery(claim)}
                className="px-3 py-1.5 text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-300 rounded-lg hover:bg-amber-100"
              >
                + Log TPA Query
              </button>
              {claim.status === 'preauth_submitted' && (
                <button
                  type="button"
                  onClick={() => setSelectedClaimForApproval(claim)}
                  className="px-3 py-1.5 text-xs font-semibold bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 shadow-sm"
                >
                  Record Pre-auth Approval
                </button>
              )}
            </div>
          )}
        </div>

        {/* Details Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 pt-4 text-xs">
          <div>
            <span className="text-ink-400 block">Policy Number</span>
            <span className="font-mono font-semibold text-ink-800">{claim.maskedPolicyNumber}</span>
          </div>
          <div>
            <span className="text-ink-400 block">Member ID</span>
            <span className="font-mono font-semibold text-ink-800">{claim.maskedMemberId || '—'}</span>
          </div>
          <div>
            <span className="text-ink-400 block">Pre-Auth Approved</span>
            <span className="font-semibold text-ink-900">{formatPaise(claim.preauthApprovedAmountPaise)}</span>
          </div>
          <div>
            <span className="text-ink-400 block">Final Settled</span>
            <span className="font-semibold text-ink-900">{formatPaise(claim.settledAmountPaise)}</span>
          </div>
        </div>
      </div>

      {/* Queries Section if any */}
      {queries.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50/30 p-5 shadow-sm space-y-3">
          <h3 className="text-sm font-bold text-ink-900 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500 animate-pulse"></span>
            TPA Deficiency Queries ({queries.length})
          </h3>
          <div className="divide-y divide-amber-200/60">
            {queries.map((q) => (
              <div key={q.id} className="py-2.5 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <div>
                  <span className="font-semibold text-ink-800">{q.queryCategory}: </span>
                  <span className="text-ink-700">{q.queryDescription}</span>
                  <div className="text-[11px] text-ink-400 mt-0.5">
                    Received: {new Date(q.receivedAt).toLocaleString()} · SLA Deadline: {new Date(q.slaDeadlineAt).toLocaleTimeString()}
                  </div>
                </div>
                <div>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${
                    q.status === 'replied' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800 font-bold'
                  }`}>
                    {q.status === 'replied' ? 'Replied' : 'Pending Hospital'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Forensic Event Timeline */}
      <div className="rounded-xl border border-ink-200 bg-white p-5 shadow-sm space-y-4">
        <h3 className="text-sm font-bold text-ink-900">Forensic Claim Timeline</h3>
        <p className="text-xs text-ink-500">Append-only audit ledger of every milestone and status transition.</p>

        <div className="relative pl-6 border-l-2 border-ink-200 space-y-6 pt-2">
          {events.map((ev) => (
            <div key={ev.id} className="relative">
              <span className="absolute -left-[31px] top-1 h-3.5 w-3.5 rounded-full border-2 border-white bg-brand-500 shadow-sm" />
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                <span className="text-xs font-bold text-ink-900">
                  {ev.eventType.replace(/_/g, ' ').toUpperCase()}
                  {ev.newStatus ? ` → ${ev.newStatus.replace(/_/g, ' ')}` : ''}
                </span>
                <span className="text-[11px] text-ink-400">
                  {new Date(ev.createdAt).toLocaleString()}
                </span>
              </div>
              {ev.notes && <p className="text-xs text-ink-600 mt-1">{ev.notes}</p>}
              {ev.amountPaise !== null && ev.amountPaise > 0 && !isNurse && (
                <p className="text-xs font-semibold text-emerald-700 mt-0.5">
                  Amount: ₹{(ev.amountPaise / 100).toLocaleString('en-IN')}
                </p>
              )}
            </div>
          ))}
        </div>
      </div>

      {selectedClaimForQuery && (
        <LogQueryModal
          claimId={selectedClaimForQuery.id}
          expectedVersion={selectedClaimForQuery.version}
          isOpen={true}
          onClose={() => setSelectedClaimForQuery(null)}
          onSubmit={async (action, payload) => {
            await claimActionHandler(action, { ...payload, admissionId: claim.admissionId });
          }}
        />
      )}

      {selectedClaimForApproval && (
        <RecordPreauthModal
          claimId={selectedClaimForApproval.id}
          expectedVersion={selectedClaimForApproval.version}
          isOpen={true}
          onClose={() => setSelectedClaimForApproval(null)}
          onSubmit={async (action, payload) => {
            await claimActionHandler(action, { ...payload, admissionId: claim.admissionId });
          }}
        />
      )}
    </div>
  );
}
