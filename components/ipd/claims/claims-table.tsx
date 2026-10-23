'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { RecordPreauthModal, LogQueryModal } from './claim-action-modals';

export type ClaimRowView = {
  id: string;
  admissionId: string;
  ipdNumber?: number | null;
  patientName: string;
  payerName: string;
  claimType: 'cashless' | 'reimbursement';
  status: string;
  version: number;
  policyNumberMasked?: string | null;
  memberIdMasked?: string | null;
  preauthAmountPaise?: number | null;
  approvedAmountPaise?: number | null;
  settledAmountPaise?: number | null;
  preauthSlaDeadline?: string | null;
  activeQueryDeadline?: string | null;
  canEdit: boolean;
};

export function ClaimsTable({
  claims,
  onAction,
}: {
  claims: ClaimRowView[];
  onAction?: (action: string, payload: Record<string, any>) => Promise<void>;
}) {
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [selectedClaim, setSelectedClaim] = useState<ClaimRowView | null>(null);
  const [activeModal, setActiveModal] = useState<'preauth' | 'query' | null>(null);

  const filtered = claims.filter((c) => {
    if (filterStatus === 'all') return true;
    if (filterStatus === 'pending') return c.status === 'preauth_submitted' || c.status === 'draft';
    if (filterStatus === 'query') return c.status === 'query_raised';
    if (filterStatus === 'approved') return c.status === 'preauth_approved' || c.status === 'claim_ready';
    if (filterStatus === 'settled') return c.status === 'settled' || c.status === 'partially_settled';
    return true;
  });

  function getStatusBadge(status: string) {
    switch (status) {
      case 'draft':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-slate-100 text-slate-700">Draft</span>;
      case 'preauth_submitted':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-800">Pre-Auth Sent</span>;
      case 'query_raised':
        return <span className="px-2 py-0.5 text-xs font-semibold rounded-full bg-rose-100 text-rose-800 animate-pulse">Query Raised</span>;
      case 'preauth_approved':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-100 text-emerald-800">Approved</span>;
      case 'claim_ready':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-indigo-100 text-indigo-800">Packet Ready</span>;
      case 'final_submitted':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-800">Dispatched</span>;
      case 'settled':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-emerald-200 text-emerald-900">Settled</span>;
      case 'partially_settled':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-amber-200 text-amber-900">Partially Settled</span>;
      case 'preauth_rejected':
      case 'claim_rejected':
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-rose-200 text-rose-900">Rejected</span>;
      default:
        return <span className="px-2 py-0.5 text-xs font-medium rounded-full bg-ink-100 text-ink-800">{status}</span>;
    }
  }

  return (
    <div className="space-y-4">
      {/* Table Filter Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 p-1 bg-ink-100/60 rounded-lg">
          {(['all', 'pending', 'query', 'approved', 'settled'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setFilterStatus(tab)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md capitalize transition-colors ${
                filterStatus === tab
                  ? 'bg-white text-ink-900 shadow-xs'
                  : 'text-ink-600 hover:text-ink-900'
              }`}
            >
              {tab === 'all' ? `All Cases (${claims.length})` : tab}
            </button>
          ))}
        </div>
      </div>

      {/* Main High-Density Table */}
      <div className="overflow-x-auto rounded-xl border border-ink-100 bg-white shadow-xs">
        <table className="w-full text-left text-sm border-collapse">
          <thead>
            <tr className="border-b border-ink-100 bg-ink-50/50 text-xs font-semibold uppercase tracking-wider text-ink-500">
              <th className="py-3 px-4">Patient / Stay</th>
              <th className="py-3 px-4">Payer / Scheme</th>
              <th className="py-3 px-4">Policy Identifier</th>
              <th className="py-3 px-4">Claim Status</th>
              <th className="py-3 px-4">Approved (₹)</th>
              <th className="py-3 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-100">
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-ink-500 text-xs">
                  No claims found matching current filter.
                </td>
              </tr>
            ) : (
              filtered.map((c) => (
                <tr key={c.id} className="hover:bg-ink-50/40 transition-colors">
                  <td className="py-3.5 px-4">
                    <div className="font-semibold text-ink-900">{c.patientName}</div>
                    <div className="text-xs text-ink-500">
                      IPD #{c.ipdNumber || '—'} ·{' '}
                      <span className="capitalize">{c.claimType}</span>
                    </div>
                  </td>

                  <td className="py-3.5 px-4">
                    <div className="font-medium text-ink-900">{c.payerName}</div>
                  </td>

                  <td className="py-3.5 px-4 font-mono text-xs text-ink-600">
                    {c.policyNumberMasked || 'Not provided'}
                  </td>

                  <td className="py-3.5 px-4">
                    {getStatusBadge(c.status)}
                  </td>

                  <td className="py-3.5 px-4 font-medium text-ink-900">
                    {c.approvedAmountPaise != null
                      ? `₹${(c.approvedAmountPaise / 100).toLocaleString('en-IN')}`
                      : c.preauthAmountPaise != null
                      ? `Est: ₹${(c.preauthAmountPaise / 100).toLocaleString('en-IN')}`
                      : '—'}
                  </td>

                  <td className="py-3.5 px-4 text-right">
                    <div className="inline-flex items-center gap-2">
                      {c.canEdit && (c.status === 'preauth_submitted' || c.status === 'draft') && (
                        <button
                          onClick={() => {
                            setSelectedClaim(c);
                            setActiveModal('preauth');
                          }}
                          className="px-2.5 py-1 text-xs font-medium rounded-md bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200"
                        >
                          Approve
                        </button>
                      )}

                      {c.canEdit && c.status !== 'settled' && (
                        <button
                          onClick={() => {
                            setSelectedClaim(c);
                            setActiveModal('query');
                          }}
                          className="px-2.5 py-1 text-xs font-medium rounded-md bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200"
                        >
                          Log Query
                        </button>
                      )}

                      <Link
                        href={`/ipd/admissions/${c.admissionId}?tab=claims`}
                        className="px-2.5 py-1 text-xs font-medium rounded-md bg-ink-100 text-ink-800 hover:bg-ink-200"
                      >
                        View File
                      </Link>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Action Modals */}
      {selectedClaim && activeModal === 'preauth' && (
        <RecordPreauthModal
          claimId={selectedClaim.id}
          expectedVersion={selectedClaim.version}
          isOpen={true}
          onClose={() => {
            setSelectedClaim(null);
            setActiveModal(null);
          }}
          onSubmit={async (act, payload) => {
            if (onAction) await onAction(act, payload);
          }}
        />
      )}

      {selectedClaim && activeModal === 'query' && (
        <LogQueryModal
          claimId={selectedClaim.id}
          expectedVersion={selectedClaim.version}
          isOpen={true}
          onClose={() => {
            setSelectedClaim(null);
            setActiveModal(null);
          }}
          onSubmit={async (act, payload) => {
            if (onAction) await onAction(act, payload);
          }}
        />
      )}
    </div>
  );
}
