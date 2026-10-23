'use client';

import React, { useState, useMemo } from 'react';
import { Card, Button, Input, Alert } from '@/components/ui';
import { maskPhone } from '@/lib/domain/booking-trace';
import type { NoticeSelectionResult, SelectedRecipient } from '@/lib/domain/notice-selection';

interface NoticePreviewStepProps {
  hospitalName: string;
  closureDate: string;
  previewData: NoticeSelectionResult | null;
  isLoading: boolean;
  isConfirming: boolean;
  onConfirm: () => void;
  onBack: () => void;
}

const PAGE_SIZE = 15;

export function NoticePreviewStep({
  hospitalName,
  closureDate,
  previewData,
  isLoading,
  isConfirming,
  onConfirm,
  onBack,
}: NoticePreviewStepProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterPriority, setFilterPriority] = useState<'all' | 'mandatory' | 'recent' | 'affected'>('all');
  const [currentPage, setCurrentPage] = useState(1);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showDisplaced, setShowDisplaced] = useState(false);

  // Filter recipients
  const filteredRecipients = useMemo(() => {
    if (!previewData?.finalRecipients) return [];
    return previewData.finalRecipients.filter((r) => {
      // Priority filter
      if (filterPriority === 'mandatory' && r.selectionReason !== 'mandatory') return false;
      if (filterPriority === 'affected' && r.selectionReason !== 'affected_appointment') return false;
      if (filterPriority === 'recent' && r.selectionReason !== 'recent_activity') return false;

      // Text search
      if (searchTerm.trim()) {
        const q = searchTerm.toLowerCase();
        const matchesName = r.patientName?.toLowerCase().includes(q);
        const matchesPhone = r.phoneE164.includes(q);
        if (!matchesName && !matchesPhone) return false;
      }

      return true;
    });
  }, [previewData, searchTerm, filterPriority]);

  const totalPages = Math.max(1, Math.ceil(filteredRecipients.length / PAGE_SIZE));
  const paginatedRecipients = useMemo(() => {
    const start = (currentPage - 1) * PAGE_SIZE;
    return filteredRecipients.slice(start, start + PAGE_SIZE);
  }, [filteredRecipients, currentPage]);

  if (isLoading || !previewData) {
    return (
      <div className="py-20 text-center">
        <div className="inline-block size-8 animate-spin rounded-full border-4 border-brand-600 border-t-transparent" />
        <p className="mt-4 text-sm font-medium text-ink-600">Calculating audience preview and capacity...</p>
      </div>
    );
  }

  const {
    totalEligibleRecipients,
    totalSelectedRecipients,
    campaignCapacity,
    accountAvailableCapacity,
    mandatoryIncludedCount,
    mandatoryAlreadyInDefaultCount,
    mandatoryAddedFromOutsideCount,
    displacedCount,
    ineligibleMandatoryCount,
    ineligibleRecipients,
    displacedRecipients,
  } = previewData;

  const notScheduledDueToCapacity = Math.max(0, totalEligibleRecipients - totalSelectedRecipients);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold text-ink-900">Step 4 — Review Recipient Selection</h2>
        <p className="mt-1 text-sm text-ink-600">
          Carefully review the recipients and capacity allocation before dispatching. Messages will be sent through the hospital&apos;s verified WhatsApp Cloud API.
        </p>
      </div>

      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Total Scheduled</span>
          <p className="mt-1 text-2xl font-bold text-brand-700">{totalSelectedRecipients}</p>
          <span className="text-xs text-ink-500">of {totalEligibleRecipients} eligible</span>
        </Card>

        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Mandatory Priority</span>
          <p className="mt-1 text-2xl font-bold text-ink-900">{mandatoryIncludedCount}</p>
          <span className="text-xs text-ink-500">
            {mandatoryAddedFromOutsideCount} added from outside top list
          </span>
        </Card>

        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Displaced Patients</span>
          <p className="mt-1 text-2xl font-bold text-amber-700">{displacedCount}</p>
          <span className="text-xs text-ink-500">Replaced by mandatory priority</span>
        </Card>

        <Card className="p-4">
          <span className="text-xs font-medium text-ink-500 uppercase tracking-wider">Account Headroom</span>
          <p className="mt-1 text-2xl font-bold text-ink-900">
            {Math.max(0, accountAvailableCapacity - totalSelectedRecipients)}
          </p>
          <span className="text-xs text-ink-500">Capacity remaining after send</span>
        </Card>
      </div>

      {/* Capacity & Exclusion Detailed Breakdown Card */}
      <Card className="p-5">
        <h3 className="text-sm font-semibold text-ink-900">Audience & Capacity Breakdown</h3>
        <div className="mt-3 grid grid-cols-1 gap-4 text-xs sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5 p-3 rounded-lg bg-ink-50">
            <span className="font-semibold text-ink-700">Selection Dynamics</span>
            <div className="flex justify-between text-ink-600">
              <span>Mandatory in default top list:</span>
              <span className="font-mono font-medium">{mandatoryAlreadyInDefaultCount}</span>
            </div>
            <div className="flex justify-between text-ink-600">
              <span>Mandatory added from outside:</span>
              <span className="font-mono font-medium">{mandatoryAddedFromOutsideCount}</span>
            </div>
            <div className="flex justify-between text-ink-600">
              <span>Displaced less-recent patients:</span>
              <span className="font-mono font-medium">{displacedCount}</span>
            </div>
          </div>

          <div className="space-y-1.5 p-3 rounded-lg bg-ink-50">
            <span className="font-semibold text-ink-700">Account Limits</span>
            <div className="flex justify-between text-ink-600">
              <span>Application Campaign Cap:</span>
              <span className="font-mono font-medium">250</span>
            </div>
            <div className="flex justify-between text-ink-600">
              <span>Meta 24h Available Capacity:</span>
              <span className="font-mono font-medium">{accountAvailableCapacity}</span>
            </div>
            <div className="flex justify-between text-ink-600">
              <span>Effective Campaign Cap:</span>
              <span className="font-mono font-medium">{campaignCapacity}</span>
            </div>
          </div>

          <div className="space-y-1.5 p-3 rounded-lg bg-ink-50">
            <span className="font-semibold text-ink-700">Exclusions & Pending</span>
            <div className="flex justify-between text-ink-600">
              <span>Ineligible mandatory numbers:</span>
              <span className="font-mono font-medium text-rose-600">{ineligibleMandatoryCount}</span>
            </div>
            <div className="flex justify-between text-ink-600">
              <span>Not scheduled due to cap:</span>
              <span className="font-mono font-medium">{notScheduledDueToCapacity}</span>
            </div>
            <div className="flex justify-between text-ink-600">
              <span>Remaining Account Capacity:</span>
              <span className="font-mono font-medium">
                {Math.max(0, accountAvailableCapacity - totalSelectedRecipients)}
              </span>
            </div>
          </div>
        </div>

        {/* Displaced list collapsible */}
        {displacedCount > 0 && (
          <div className="mt-4 pt-3 border-t border-ink-100">
            <button
              type="button"
              onClick={() => setShowDisplaced(!showDisplaced)}
              className="text-xs font-semibold text-brand-700 hover:text-brand-900 flex items-center gap-1"
            >
              <span>{showDisplaced ? '▾ Hide' : '▸ View'} {displacedCount} displaced recipient(s)</span>
            </button>

            {showDisplaced && (
              <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-ink-200 bg-amber-50/30 p-2 divide-y divide-ink-100">
                {displacedRecipients.map((d, i) => (
                  <div key={i} className="py-1 text-xs flex justify-between text-ink-700">
                    <span>{d.patientName} ({maskPhone(d.phoneE164)})</span>
                    <span className="text-ink-500 italic">{d.reason}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Card>

      {/* Ineligible Alert */}
      {ineligibleRecipients.length > 0 && (
        <Alert tone="warn">
          <p className="font-semibold text-xs text-amber-900">
            {ineligibleRecipients.length} mandatory number(s) will be suppressed due to policy/consent:
          </p>
          <p className="text-[11px] text-amber-800 mt-0.5">
            These numbers are not enrolled or have opted out of WhatsApp communications. WhatsApp Cloud API requires valid opt-in.
          </p>
        </Alert>
      )}

      {/* Recipient Table */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-ink-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Selected Recipients ({filteredRecipients.length})
            </h3>
            <p className="text-xs text-ink-500">
              Showing deterministic priority ordering: Mandatory Priority first, followed by most recent activity.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={filterPriority}
              onChange={(e) => {
                setFilterPriority(e.target.value as any);
                setCurrentPage(1);
              }}
              aria-label="Filter recipient priority"
              className="h-8 rounded-lg border-ink-300 text-xs text-ink-700 bg-white ring-1 ring-inset ring-ink-300 px-2"
            >
              <option value="all">All Priorities</option>
              <option value="mandatory">Mandatory Only</option>
              <option value="affected">Affected Appointment Only</option>
              <option value="recent">Recent OPD Activity Only</option>
            </select>

            <div className="w-48">
              <Input
                type="text"
                placeholder="Search list..."
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setCurrentPage(1);
                }}
                className="h-8 text-xs py-1"
              />
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-ink-50 text-ink-600 font-medium border-b border-ink-200">
              <tr>
                <th className="py-2.5 px-4">#</th>
                <th className="py-2.5 px-4">Patient Name</th>
                <th className="py-2.5 px-4">Phone Number</th>
                <th className="py-2.5 px-4">Priority / Reason</th>
                <th className="py-2.5 px-4">Last Interaction</th>
                <th className="py-2.5 px-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 text-ink-800">
              {paginatedRecipients.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-ink-400 italic">
                    No recipients match your filter criteria
                  </td>
                </tr>
              ) : (
                paginatedRecipients.map((r, index) => {
                  const globalIndex = (currentPage - 1) * PAGE_SIZE + index + 1;
                  return (
                    <tr key={r.phoneE164} className="hover:bg-ink-50/50">
                      <td className="py-2.5 px-4 font-mono text-ink-400">{globalIndex}</td>
                      <td className="py-2.5 px-4 font-medium text-ink-900">{r.patientName}</td>
                      <td className="py-2.5 px-4 font-mono text-ink-600">{maskPhone(r.phoneE164)}</td>
                      <td className="py-2.5 px-4">
                        {r.selectionReason === 'mandatory' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-violet-50 text-violet-700 ring-1 ring-violet-200">
                            ★ Mandatory Priority
                          </span>
                        ) : r.selectionReason === 'affected_appointment' ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-800 ring-1 ring-amber-200">
                            Affected Appointment
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-50 text-sky-700 ring-1 ring-sky-200">
                            Recent OPD Activity
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-ink-500">
                        {new Date(r.lastActivityAt).toLocaleDateString('en-IN', {
                          day: '2-digit',
                          month: 'short',
                          year: 'numeric',
                        })}{' '}
                        <span className="text-[10px] text-ink-400">({r.activityType.replace('_', ' ')})</span>
                      </td>
                      <td className="py-2.5 px-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
                          Eligible
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="p-3 border-t border-ink-100 flex items-center justify-between text-xs text-ink-500">
            <span>
              Showing {(currentPage - 1) * PAGE_SIZE + 1} to{' '}
              {Math.min(currentPage * PAGE_SIZE, filteredRecipients.length)} of {filteredRecipients.length}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={currentPage <= 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="px-2 font-medium text-ink-700">
                {currentPage} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={currentPage >= totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Action Buttons */}
      <div className="flex items-center justify-between pt-4 border-t border-ink-200">
        <Button variant="secondary" onClick={onBack} disabled={isConfirming}>
          ← Back to Edit Recipients
        </Button>
        <Button
          variant="primary"
          onClick={() => setShowConfirmModal(true)}
          disabled={isConfirming || totalSelectedRecipients === 0}
          className="min-w-40 font-semibold"
        >
          Confirm & Send Notice ({totalSelectedRecipients}) →
        </Button>
      </div>

      {/* Confirmation Modal */}
      {showConfirmModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-ink-200 space-y-4">
            <h3 className="text-base font-bold text-ink-900">Confirm Notice Dispatch</h3>
            <p className="text-xs text-ink-600 leading-relaxed">
              You are about to send official WhatsApp hospital closure notices on behalf of{' '}
              <strong className="text-ink-900">{hospitalName}</strong> to{' '}
              <strong className="text-ink-900">{totalSelectedRecipients} patients</strong>.
            </p>

            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
              <p className="font-semibold">Consequential Action</p>
              <p>
                Messages will be queued immediately and sent via Meta WhatsApp Cloud API. Messages cannot be recalled once accepted by Meta.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="secondary"
                onClick={() => setShowConfirmModal(false)}
                disabled={isConfirming}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setShowConfirmModal(false);
                  onConfirm();
                }}
                isLoading={isConfirming}
                className="bg-brand-600 hover:bg-brand-700 font-semibold"
              >
                Yes, Send {totalSelectedRecipients} Notices
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
