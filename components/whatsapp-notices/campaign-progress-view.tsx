'use client';

import React, { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Card, Button, Input, Alert } from '@/components/ui';
import { maskPhone } from '@/lib/domain/booking-trace';

interface CampaignDetails {
  id: string;
  title: string;
  noticeType: string;
  status: 'draft' | 'scheduled' | 'processing' | 'completed' | 'partially_completed' | 'cancelled' | 'failed';
  closureDate: string | null;
  closureEndDate: string | null;
  closureDuration: string | null;
  reason: string | null;
  rescheduleInstructions: string | null;
  contactPhone: string | null;
  templateCode: string;
  totalTargetRecipients: number;
  mandatoryRecipientsCount: number;
  recentRecipientsCount: number;
  displacedRecipientsCount: number;
  ineligibleRecipientsCount: number;
  sentCount: number;
  deliveredCount: number;
  readCount: number;
  failedCount: number;
  suppressedCount: number;
  pendingCapacityCount: number;
  confirmedAt: string | null;
  confirmedByName?: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
}

interface RecipientRow {
  id: string;
  patientId: string | null;
  phoneE164: string;
  patientName: string;
  priority: number;
  selectionReason: string;
  lastActivityAt: string;
  activityType: string;
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'suppressed' | 'cancelled';
  attempts: number;
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
  failedReason: string | null;
}

interface CampaignProgressViewProps {
  campaignId: string;
  hospitalId: string;
  initialCampaign: CampaignDetails;
}

export function CampaignProgressView({
  campaignId,
  hospitalId,
  initialCampaign,
}: CampaignProgressViewProps) {
  const [campaign, setCampaign] = useState<CampaignDetails>(initialCampaign);
  const [recipients, setRecipients] = useState<RecipientRow[]>([]);
  const [totalRecipients, setTotalRecipients] = useState(0);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoadingRecipients, setIsLoadingRecipients] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Poll campaign status and counts
  const fetchCampaign = useCallback(async () => {
    try {
      const res = await fetch(`/api/whatsapp-notices/${campaignId}`);
      if (res.ok) {
        const data = await res.json();
        setCampaign(data);
      }
    } catch {
      // ignore transient poll error
    }
  }, [campaignId]);

  // Fetch recipients
  const fetchRecipients = useCallback(async () => {
    setIsLoadingRecipients(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        pageSize: '15',
        status: statusFilter,
        search: searchQuery.trim(),
      });
      const res = await fetch(`/api/whatsapp-notices/${campaignId}/recipients?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setRecipients(data.items || []);
        setTotalRecipients(data.total || 0);
        setTotalPages(data.totalPages || 1);
      }
    } catch {
      // ignore
    } finally {
      setIsLoadingRecipients(false);
    }
  }, [campaignId, page, statusFilter, searchQuery]);

  // Auto-refresh timer while campaign is active
  useEffect(() => {
    fetchCampaign();
    fetchRecipients();

    const isActive = campaign.status === 'scheduled' || campaign.status === 'processing';
    if (!isActive) return;

    const interval = setInterval(() => {
      fetchCampaign();
      fetchRecipients();
    }, 4000);

    return () => clearInterval(interval);
  }, [fetchCampaign, fetchRecipients, campaign.status]);

  // Handle campaign cancellation
  const handleCancel = async () => {
    setIsCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/whatsapp-notices/${campaignId}/cancel`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to cancel notice campaign');
      }
      setShowCancelModal(false);
      await fetchCampaign();
      await fetchRecipients();
    } catch (err: any) {
      setCancelError(err.message || 'Error cancelling campaign');
    } finally {
      setIsCancelling(false);
    }
  };

  const isCompleted = campaign.status === 'completed';
  const isCancelled = campaign.status === 'cancelled';
  const isActive = campaign.status === 'scheduled' || campaign.status === 'processing';

  const processedCount = campaign.sentCount + campaign.failedCount + campaign.suppressedCount;
  const progressPercent = campaign.totalTargetRecipients > 0
    ? Math.min(100, Math.round((processedCount / campaign.totalTargetRecipients) * 100))
    : 0;

  return (
    <div className="space-y-6">
      {/* Top Breadcrumb & Status Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Link
            href="/whatsapp-notices"
            className="text-xs font-medium text-brand-600 hover:text-brand-800 transition-colors"
          >
            ← Back to WhatsApp Notices
          </Link>
          <div className="mt-1 flex items-center gap-3">
            <h1 className="text-xl font-bold text-ink-900">{campaign.title}</h1>
            <span
              className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold uppercase tracking-wider ${
                campaign.status === 'completed'
                  ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                  : campaign.status === 'processing'
                  ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200 animate-pulse'
                  : campaign.status === 'cancelled'
                  ? 'bg-ink-100 text-ink-600 ring-1 ring-ink-200'
                  : 'bg-amber-50 text-amber-800 ring-1 ring-amber-200'
              }`}
            >
              {campaign.status}
            </span>
          </div>
          <p className="text-xs text-ink-500 mt-0.5">
            Notice Date:{' '}
            {campaign.closureEndDate && campaign.closureEndDate !== campaign.closureDate
              ? `${campaign.closureDate} to ${campaign.closureEndDate}`
              : (campaign.closureDate || 'N/A')}{' '}
            · Template: <span className="font-mono">{campaign.templateCode}</span> · Contact:{' '}
            <span className="font-mono">{campaign.contactPhone}</span>
          </p>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {isActive && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => setShowCancelModal(true)}
              disabled={isCancelling}
            >
              Cancel Remaining
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              fetchCampaign();
              fetchRecipients();
            }}
          >
            ↻ Refresh
          </Button>
        </div>
      </div>

      {/* Progress Bar */}
      <Card className="p-4 space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-semibold text-ink-700">Dispatch Progress</span>
          <span className="font-mono font-medium text-ink-900">
            {processedCount} of {campaign.totalTargetRecipients} processed ({progressPercent}%)
          </span>
        </div>
        <div className="w-full bg-ink-100 rounded-full h-2.5 overflow-hidden">
          <div
            className={`h-2.5 transition-all duration-500 ${
              isCompleted
                ? 'bg-emerald-600'
                : isCancelled
                ? 'bg-ink-400'
                : 'bg-brand-600'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </Card>

      {/* Real-time Status Metric Counters */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-ink-500">Target</span>
          <p className="text-xl font-bold text-ink-900">{campaign.totalTargetRecipients}</p>
        </Card>

        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-sky-600">Accepted</span>
          <p className="text-xl font-bold text-sky-700">{campaign.sentCount}</p>
          <span className="text-[10px] text-ink-400">by Meta Cloud API</span>
        </Card>

        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-emerald-600">Delivered</span>
          <p className="text-xl font-bold text-emerald-700">{campaign.deliveredCount}</p>
          <span className="text-[10px] text-ink-400">to handsets</span>
        </Card>

        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-teal-600">Read</span>
          <p className="text-xl font-bold text-teal-700">{campaign.readCount}</p>
          <span className="text-[10px] text-ink-400">read receipts</span>
        </Card>

        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-rose-600">Failed</span>
          <p className="text-xl font-bold text-rose-700">{campaign.failedCount}</p>
          <span className="text-[10px] text-ink-400">permanent / network</span>
        </Card>

        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-amber-600">Suppressed</span>
          <p className="text-xl font-bold text-amber-700">{campaign.suppressedCount}</p>
          <span className="text-[10px] text-ink-400">opted-out / no opt-in</span>
        </Card>

        <Card className="p-3">
          <span className="text-[10px] font-semibold uppercase text-ink-500">Pending</span>
          <p className="text-xl font-bold text-ink-800">
            {Math.max(
              0,
              campaign.totalTargetRecipients - (campaign.sentCount + campaign.failedCount + campaign.suppressedCount),
            )}
          </p>
          <span className="text-[10px] text-ink-400">in worker queue</span>
        </Card>
      </div>

      {cancelError && (
        <Alert tone="error">
          <p className="text-xs font-semibold">{cancelError}</p>
        </Alert>
      )}

      {/* Recipient Delivery Log Table */}
      <Card className="overflow-hidden">
        <div className="p-4 border-b border-ink-200 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Recipient Delivery Log ({totalRecipients})
            </h3>
            <p className="text-xs text-ink-500">
              Per-recipient delivery status updated in real-time via Meta webhooks.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setPage(1);
              }}
              aria-label="Filter recipient status"
              className="h-8 rounded-lg border-ink-300 text-xs text-ink-700 bg-white ring-1 ring-inset ring-ink-300 px-2"
            >
              <option value="all">All Statuses</option>
              <option value="queued">Queued</option>
              <option value="sending">Sending</option>
              <option value="sent">Accepted by Meta</option>
              <option value="delivered">Delivered</option>
              <option value="read">Read</option>
              <option value="failed">Failed</option>
              <option value="suppressed">Suppressed</option>
              <option value="cancelled">Cancelled</option>
            </select>

            <div className="w-48">
              <Input
                type="text"
                placeholder="Search patient / phone..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(1);
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
                <th className="py-2.5 px-4">Patient</th>
                <th className="py-2.5 px-4">Phone</th>
                <th className="py-2.5 px-4">Priority / Reason</th>
                <th className="py-2.5 px-4">Delivery Status</th>
                <th className="py-2.5 px-4">Attempts</th>
                <th className="py-2.5 px-4">Timestamps / Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 text-ink-800">
              {isLoadingRecipients ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-ink-400 italic">
                    Loading recipient statuses...
                  </td>
                </tr>
              ) : recipients.length === 0 ? (
                <tr>
                  <td colSpan={6} className="py-8 text-center text-ink-400 italic">
                    No recipients match the selected filter.
                  </td>
                </tr>
              ) : (
                recipients.map((r) => (
                  <tr key={r.id} className="hover:bg-ink-50/50">
                    <td className="py-2.5 px-4 font-medium text-ink-900">{r.patientName}</td>
                    <td className="py-2.5 px-4 font-mono text-ink-600">{maskPhone(r.phoneE164)}</td>
                    <td className="py-2.5 px-4">
                      {r.selectionReason === 'mandatory' ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-violet-50 text-violet-700">
                          ★ Mandatory
                        </span>
                      ) : r.selectionReason === 'affected_appointment' ? (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-amber-50 text-amber-800">
                          Affected Appt
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-50 text-sky-700">
                          Recent OPD
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 px-4">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          r.status === 'read'
                            ? 'bg-teal-50 text-teal-700 ring-1 ring-teal-200'
                            : r.status === 'delivered'
                            ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                            : r.status === 'sent'
                            ? 'bg-sky-50 text-sky-700 ring-1 ring-sky-200'
                            : r.status === 'sending'
                            ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200 animate-pulse'
                            : r.status === 'failed'
                            ? 'bg-rose-50 text-rose-700 ring-1 ring-rose-200'
                            : r.status === 'suppressed'
                            ? 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'
                            : 'bg-ink-100 text-ink-600'
                        }`}
                      >
                        {r.status === 'sent' ? 'Accepted' : r.status}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 font-mono text-ink-500">{r.attempts}</td>
                    <td className="py-2.5 px-4 text-ink-500">
                      {r.failedReason ? (
                        <span className="text-rose-600 font-mono text-[11px] truncate max-w-xs block" title={r.failedReason}>
                          {r.failedReason}
                        </span>
                      ) : r.readAt ? (
                        <span>Read {new Date(r.readAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                      ) : r.deliveredAt ? (
                        <span>Delivered {new Date(r.deliveredAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                      ) : r.sentAt ? (
                        <span>Sent {new Date(r.sentAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                      ) : (
                        <span className="text-ink-400 italic">—</span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination controls */}
        {totalPages > 1 && (
          <div className="p-3 border-t border-ink-100 flex items-center justify-between text-xs text-ink-500">
            <span>
              Showing {(page - 1) * 15 + 1} to {Math.min(page * 15, totalRecipients)} of {totalRecipients}
            </span>
            <div className="flex items-center gap-1">
              <Button
                size="sm"
                variant="ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                Previous
              </Button>
              <span className="px-2 font-medium text-ink-700">
                {page} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* Cancel Confirmation Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl ring-1 ring-ink-200 space-y-4">
            <h3 className="text-base font-bold text-ink-900">Cancel Remaining Messages?</h3>
            <p className="text-xs text-ink-600 leading-relaxed">
              This will stop the worker queue and mark any remaining <strong>unsent</strong> messages as cancelled. Unused reserved capacity will be immediately returned to the hospital account.
            </p>

            <div className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 space-y-1">
              <p className="font-semibold">Note on WhatsApp Recall</p>
              <p>
                Messages already accepted by Meta ({campaign.sentCount}) cannot be recalled and will be delivered to patient devices.
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                variant="secondary"
                onClick={() => setShowCancelModal(false)}
                disabled={isCancelling}
              >
                Keep Sending
              </Button>
              <Button
                variant="danger"
                onClick={handleCancel}
                isLoading={isCancelling}
                className="font-semibold"
              >
                Yes, Cancel Remaining
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
