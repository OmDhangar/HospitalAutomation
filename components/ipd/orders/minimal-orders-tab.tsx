'use client';

import React, { useState } from 'react';
import { Drawer } from '@/components/ipd/drawer';
import { StatusBadge } from '@/components/ipd/status-badge';
import { StopReasons, type StopReason } from '@/constants/clinical';
import { CreateTreatmentPlanModal } from '@/components/ipd/prescriptions/create-treatment-plan-modal';
import { PlusIcon } from '@/components/icons';

import {
  cosignVerbalOrderAction,
  rejectVerbalOrderAction,
  approveDraftMedicationOrderAction,
  approveAllDraftMedicationOrdersAction,
  rejectDraftMedicationOrderAction,
} from '@/app/(app)/ipd/actions';
import { AlertTriangleIcon, CheckIcon, XIcon, ClockIcon } from '@/components/icons';

export interface PendingVerbalOrderItem {
  id: string;
  medicineName: string;
  doseAmount: string;
  doseUnit: string;
  route: string;
  verbalDoctorName?: string | null;
  verbalClinicalRationale?: string | null;
  createdAt: string | Date;
}

export interface DraftMedicationOrderItem {
  id: string;
  orderChainId?: string;
  medicineId?: string;
  medicineName: string;
  strength?: string | null;
  doseAmount: string;
  doseUnit: string;
  route: string;
  frequencyCode: string;
  scheduleTimes?: string[];
  scheduleType?: string;
  isPrn?: boolean;
  specialInstructions?: string | null;
  origin?: string;
  status: string;
  createdAt?: string | Date;
}

export interface MedicationOrderViewItem {
  id: string;
  medicineName: string;
  doseAmount: string;
  doseUnit: string;
  route: string;
  status: string;
  frequencyCode: string;
  scheduleTimes: string[];
  instructions?: string | null;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
}

export interface MinimalOrdersTabProps {
  admissionId: string;
  orders: MedicationOrderViewItem[];
  pendingVerbalOrders?: PendingVerbalOrderItem[];
  draftOrders?: DraftMedicationOrderItem[];
  patientName?: string;
  uhid?: string;
  bedLabel?: string;
  initialDiagnosis?: string | null;
  canPrescribe?: boolean;
  onStopOrder?: (orderId: string, reason: StopReason, notes?: string) => Promise<void>;
  onModifyOrder?: (orderId: string) => void;
  className?: string;
}

export function MinimalOrdersTab({
  admissionId,
  orders = [],
  pendingVerbalOrders = [],
  draftOrders = [],
  patientName = 'Patient',
  uhid = 'UHID',
  bedLabel,
  initialDiagnosis,
  canPrescribe = true,
  onStopOrder,
  onModifyOrder,
  className = '',
}: MinimalOrdersTabProps) {
  const [selectedOrderToStop, setSelectedOrderToStop] = useState<MedicationOrderViewItem | null>(null);
  const [stopReason, setStopReason] = useState<StopReason>(StopReasons[0]);
  const [stopNotes, setStopNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [modifyNotice, setModifyNotice] = useState<string | null>(null);
  const [isPrescribeModalOpen, setIsPrescribeModalOpen] = useState(false);

  // Verbal order co-sign / reject modal state
  const [activeVerbalAction, setActiveVerbalAction] = useState<{
    order: PendingVerbalOrderItem;
    type: 'cosign' | 'reject';
  } | null>(null);
  const [verbalActionNotes, setVerbalActionNotes] = useState('');
  const [verbalActionError, setVerbalActionError] = useState<string | null>(null);
  const [verbalSuccessMsg, setVerbalSuccessMsg] = useState<string | null>(null);

  // Draft orders review state
  const [isDraftSubmitting, setIsDraftSubmitting] = useState(false);
  const [draftFeedback, setDraftFeedback] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [activeRejectDraft, setActiveRejectDraft] = useState<DraftMedicationOrderItem | null>(null);
  const [rejectDraftReason, setRejectDraftReason] = useState('');
  const [activeAllergyDraft, setActiveAllergyDraft] = useState<{
    order: DraftMedicationOrderItem;
    conflictError: string;
    overrideReason: string;
  } | null>(null);

  const handleApproveDraft = async (order: DraftMedicationOrderItem, overrideReason?: string) => {
    try {
      setIsDraftSubmitting(true);
      setDraftFeedback(null);
      const res = await approveDraftMedicationOrderAction({
        admissionId,
        orderId: order.id,
        allergyOverrideReason: overrideReason,
      });

      if (!res.ok) {
        if (res.error && (res.error.toLowerCase().includes('allergy') || res.error.toLowerCase().includes('conflict'))) {
          setActiveAllergyDraft({
            order,
            conflictError: res.error,
            overrideReason: '',
          });
        } else {
          setDraftFeedback({ type: 'error', message: res.error || 'Failed to approve draft order' });
        }
        return;
      }

      setDraftFeedback({
        type: 'success',
        message: `Medication "${order.medicineName}" approved and activated on bedside eMAR.`,
      });
      setActiveAllergyDraft(null);
      setTimeout(() => setDraftFeedback(null), 5000);
    } catch (err: any) {
      setDraftFeedback({ type: 'error', message: err?.message || 'Approval action failed' });
    } finally {
      setIsDraftSubmitting(false);
    }
  };

  const handleApproveAllDrafts = async (overrideReason?: string) => {
    try {
      setIsDraftSubmitting(true);
      setDraftFeedback(null);
      const res = await approveAllDraftMedicationOrdersAction({
        admissionId,
        allergyOverrideReason: overrideReason,
      });

      if (!res.ok) {
        setDraftFeedback({ type: 'error', message: res.error || 'Failed to approve draft orders' });
        return;
      }

      if (res.errors && res.errors.length > 0) {
        setDraftFeedback({
          type: 'error',
          message: `Approved ${res.approvedCount} order(s). Some orders required attention: ${res.errors.join('; ')}`,
        });
      } else {
        setDraftFeedback({
          type: 'success',
          message: `All ${res.approvedCount} draft order(s) successfully approved and activated on bedside eMAR.`,
        });
      }
      setTimeout(() => setDraftFeedback(null), 6000);
    } catch (err: any) {
      setDraftFeedback({ type: 'error', message: err?.message || 'Bulk approval failed' });
    } finally {
      setIsDraftSubmitting(false);
    }
  };

  const handleConfirmRejectDraft = async () => {
    if (!activeRejectDraft) return;
    const trimmed = rejectDraftReason.trim();
    if (trimmed.length < 3) {
      setDraftFeedback({ type: 'error', message: 'Rejection reason must be at least 3 characters.' });
      return;
    }

    try {
      setIsDraftSubmitting(true);
      const res = await rejectDraftMedicationOrderAction({
        admissionId,
        orderId: activeRejectDraft.id,
        reason: trimmed,
      });

      if (!res.ok) {
        setDraftFeedback({ type: 'error', message: res.error || 'Failed to reject draft order' });
        return;
      }

      setDraftFeedback({
        type: 'success',
        message: `Draft order for "${activeRejectDraft.medicineName}" was rejected and removed.`,
      });
      setActiveRejectDraft(null);
      setRejectDraftReason('');
      setTimeout(() => setDraftFeedback(null), 4000);
    } catch (err: any) {
      setDraftFeedback({ type: 'error', message: err?.message || 'Rejection failed' });
    } finally {
      setIsDraftSubmitting(false);
    }
  };

  const handleConfirmStop = async () => {
    if (!selectedOrderToStop) return;
    try {
      setIsSubmitting(true);
      if (onStopOrder) {
        await onStopOrder(selectedOrderToStop.id, stopReason, stopNotes);
      }
      setSelectedOrderToStop(null);
      setStopNotes('');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 bg-surface p-4 rounded-lg border border-ink-100 shadow-xs">
        <div>
          <h2 className="text-base font-semibold text-ink-900">Doctor Prescriptions &amp; Treatment Plan</h2>
          <p className="text-xs text-ink-500">
            Active prescriptions under clinical administration. Doctor can prescribe new medications or update treatment plan as per patient diagnosis.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-xs font-semibold text-ink-600">
            Total Active: <span className="text-ink-950 font-bold">{orders.length}</span>
          </div>
          {canPrescribe && (
            <button
              type="button"
              onClick={() => setIsPrescribeModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs transition-colors"
            >
              <PlusIcon className="size-3.5" />
              <span>+ Create Treatment Plan / Prescribe</span>
            </button>
          )}
        </div>
      </div>

      {verbalSuccessMsg && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-md">
          {verbalSuccessMsg}
        </div>
      )}

      {draftFeedback && (
        <div
          className={`p-3 rounded-md text-xs font-medium border ${
            draftFeedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {draftFeedback.message}
        </div>
      )}

      {/* Pending OPD Draft Orders Review Banner */}
      {draftOrders.length > 0 && (
        <div className="rounded-xl border-2 border-amber-400 bg-amber-50/70 p-4 space-y-3.5 shadow-2xs">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold mt-0.5">
                !
              </span>
              <div>
                <h3 className="text-sm font-bold text-amber-950 flex items-center gap-2">
                  <span>{`Pending Admission Orders from OPD (${draftOrders.length})`}</span>
                  <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded bg-amber-200 text-amber-900">
                    Awaiting Doctor Sign-off
                  </span>
                </h3>
                <p className="text-xs text-amber-800 mt-0.5">
                  Ported from outpatient doctor consultation during admission. Active inpatient treatment requires doctor confirmation.
                </p>
              </div>
            </div>
            {canPrescribe && (
              <button
                type="button"
                disabled={isDraftSubmitting}
                onClick={() => handleApproveAllDrafts()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs transition-colors shrink-0 disabled:opacity-50"
              >
                <CheckIcon className="size-3.5" />
                <span>Approve All Valid Orders</span>
              </button>
            )}
          </div>

          <div className="divide-y divide-amber-200/80 rounded-lg border border-amber-200 bg-surface overflow-hidden text-xs">
            {draftOrders.map((draft) => (
              <div
                key={draft.id}
                className="p-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 hover:bg-amber-50/30 transition-colors"
              >
                <div className="space-y-1">
                  <div className="font-bold text-ink-950 text-sm flex items-center gap-2">
                    <span>{draft.medicineName}</span>
                    {draft.strength && <span className="text-xs font-normal text-ink-500">({draft.strength})</span>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs text-ink-700">
                    <span className="font-semibold text-ink-900 bg-ink-100 px-1.5 py-0.5 rounded">
                      {draft.doseAmount} {draft.doseUnit}
                    </span>
                    <span>·</span>
                    <span className="uppercase text-ink-600">{draft.route}</span>
                    <span>·</span>
                    <span className="font-medium text-ink-800">
                      {draft.isPrn
                        ? 'PRN (SOS)'
                        : `${draft.frequencyCode}${
                            draft.scheduleTimes && draft.scheduleTimes.length > 0
                              ? ` (${draft.scheduleTimes.join(', ')})`
                              : ''
                          }`}
                    </span>
                  </div>
                  {draft.specialInstructions && (
                    <div className="text-[11px] text-ink-500 italic mt-0.5">
                      “{draft.specialInstructions}”
                    </div>
                  )}
                </div>

                {canPrescribe && (
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      disabled={isDraftSubmitting}
                      onClick={() => handleApproveDraft(draft)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 min-h-8 disabled:opacity-50"
                    >
                      <CheckIcon className="size-3.5" />
                      <span>Approve</span>
                    </button>
                    <button
                      type="button"
                      disabled={isDraftSubmitting}
                      onClick={() => {
                        if (onModifyOrder) {
                          onModifyOrder(draft.id);
                        } else {
                          setIsPrescribeModalOpen(true);
                        }
                      }}
                      className="px-2.5 py-1.5 text-xs font-semibold rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-8"
                    >
                      Modify
                    </button>
                    <button
                      type="button"
                      disabled={isDraftSubmitting}
                      onClick={() => {
                        setActiveRejectDraft(draft);
                        setRejectDraftReason('');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold rounded-md border border-rose-300 text-rose-700 hover:bg-rose-50 min-h-8 disabled:opacity-50"
                    >
                      <XIcon className="size-3.5" />
                      <span>Reject</span>
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Pending Verbal Orders Co-Sign Alert Strip */}
      {pendingVerbalOrders.length > 0 && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50/70 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-amber-500 text-white text-xs font-bold">
                !
              </span>
              <h3 className="text-sm font-bold text-amber-950">
                Pending Verbal Orders Awaiting Doctor Co-Signature ({pendingVerbalOrders.length})
              </h3>
            </div>
            <span className="text-2xs font-semibold text-amber-800 bg-amber-100 px-2 py-0.5 rounded">
              NABH Protocol §6.2
            </span>
          </div>

          <div className="divide-y divide-amber-200/80 rounded border border-amber-200 bg-white overflow-hidden text-xs">
            {pendingVerbalOrders.map((vo) => (
              <div key={vo.id} className="p-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="space-y-1">
                  <div className="font-bold text-ink-900 text-sm">
                    {vo.medicineName} · <span className="font-semibold text-ink-700">{vo.doseAmount} {vo.doseUnit}</span> ({vo.route})
                  </div>
                  <div className="text-xs text-ink-600">
                    Authority: <strong className="text-ink-800">{vo.verbalDoctorName ? `Dr. ${vo.verbalDoctorName}` : 'Emergency Verbal Protocol'}</strong>
                    {vo.verbalClinicalRationale && (
                      <span className="ml-2 italic text-ink-500">“{vo.verbalClinicalRationale}”</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => {
                      setActiveVerbalAction({ order: vo, type: 'cosign' });
                      setVerbalActionNotes('');
                      setVerbalActionError(null);
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded bg-emerald-600 text-white hover:bg-emerald-700 min-h-8"
                  >
                    <CheckIcon className="size-3.5" />
                    <span>Co-Sign Order</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveVerbalAction({ order: vo, type: 'reject' });
                      setVerbalActionNotes('');
                      setVerbalActionError(null);
                    }}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-bold rounded border border-rose-300 text-rose-700 hover:bg-rose-50 min-h-8"
                  >
                    <XIcon className="size-3.5" />
                    <span>Reject</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {modifyNotice && (
        <div className="p-3 bg-sky-50 border border-sky-200 text-sky-800 text-xs rounded-md flex items-center justify-between">
          <span>{modifyNotice}</span>
          <button
            type="button"
            onClick={() => setModifyNotice(null)}
            className="text-sky-600 hover:text-sky-900 font-bold ml-2"
          >
            ✕
          </button>
        </div>
      )}

      {/* Orders Table */}
      {orders.length === 0 ? (
        <div className="bg-surface p-8 text-center rounded-lg border border-ink-100 shadow-xs space-y-3">
          <div>
            <p className="text-sm font-semibold text-ink-700">No active prescriptions recorded</p>
            <p className="text-xs text-ink-400 mt-1">
              Set up initial disease-based treatment plan, IV fluids, and medications for this patient stay.
            </p>
          </div>
          {canPrescribe && (
            <div>
              <button
                type="button"
                onClick={() => setIsPrescribeModalOpen(true)}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs transition-colors"
              >
                <PlusIcon className="size-3.5" />
                <span>+ Create Treatment Plan &amp; Prescribe</span>
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto bg-surface rounded-lg border border-ink-100 shadow-xs">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-ink-50 text-ink-700 font-semibold border-b border-ink-100">
              <tr>
                <th className="py-3 px-4">Medication</th>
                <th className="py-3 px-4">Dose &amp; Route</th>
                <th className="py-3 px-4">Frequency / Timings</th>
                <th className="py-3 px-4">Status</th>
                <th className="py-3 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-ink-100 text-ink-800">
              {orders.map((order) => (
                <tr key={order.id} className="hover:bg-ink-50/50 transition-colors">
                  <td className="py-3 px-4 font-semibold text-ink-950">
                    <div>{order.medicineName}</div>
                    {order.instructions && (
                      <div className="text-[11px] text-ink-500 font-normal italic">
                        {order.instructions}
                      </div>
                    )}
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-ink-800">
                      {order.doseAmount} {order.doseUnit}
                    </div>
                    <div className="text-ink-500 uppercase text-[11px] font-normal">
                      {order.route}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <div className="font-semibold text-ink-800">
                      {order.frequencyCode}
                    </div>
                    <div className="text-ink-500 text-[11px]">
                      {order.scheduleTimes?.length > 0
                        ? order.scheduleTimes.join(', ')
                        : 'PRN (SOS)'}
                    </div>
                  </td>
                  <td className="py-3 px-4">
                    <StatusBadge
                      status={order.status === 'active' ? 'Active' : order.status}
                      variant={order.status === 'active' ? 'green' : 'grey'}
                    />
                  </td>
                  <td className="py-3 px-4 text-right space-x-2">
                    <button
                      type="button"
                      onClick={() => setSelectedOrderToStop(order)}
                      className="px-2.5 py-1 text-xs font-semibold rounded border border-rose-200 text-rose-700 hover:bg-rose-50 min-h-[32px]"
                    >
                      Stop Order
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (onModifyOrder) {
                          onModifyOrder(order.id);
                        } else {
                          setModifyNotice(
                            `Order ${order.medicineName} can be modified or renewed in Doctor Rounding Cockpit.`,
                          );
                        }
                      }}
                      className="px-2.5 py-1 text-xs font-semibold rounded border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[32px]"
                    >
                      Modify
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Stop Order Reason Drawer */}
      <Drawer
        isOpen={Boolean(selectedOrderToStop)}
        onClose={() => setSelectedOrderToStop(null)}
        title="Discontinue Medication Order"
        patient={{
          name: patientName,
          uhid,
          bedLabel,
        }}
        footer={
          <div className="flex items-center justify-end gap-3 w-full">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setSelectedOrderToStop(null)}
              className="px-4 py-2 text-xs font-semibold rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={handleConfirmStop}
              className="px-4 py-2 text-xs font-semibold rounded-md bg-rose-600 text-white hover:bg-rose-700 min-h-[44px]"
            >
              {isSubmitting ? 'Stopping...' : 'Confirm Discontinue'}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-ink-600">
            You are discontinuing{' '}
            <span className="font-semibold text-ink-900">
              {selectedOrderToStop?.medicineName}
            </span>
            . All pending future scheduled doses will be cancelled.
          </p>

          <div>
            <label className="block text-xs font-semibold text-ink-800 mb-1">
              Reason for Discontinuing (Required)
            </label>
            <select
              value={stopReason}
              onChange={(e) => setStopReason(e.target.value as StopReason)}
              className="w-full text-xs p-2 rounded border border-ink-200 bg-surface text-ink-900 focus:outline-none focus:ring-2 focus:ring-primary min-h-[44px]"
            >
              {StopReasons.map((reason) => (
                <option key={reason} value={reason}>
                  {reason}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-ink-800 mb-1">
              Clinical Notes / Justification
            </label>
            <textarea
              value={stopNotes}
              onChange={(e) => setStopNotes(e.target.value)}
              placeholder="Provide clinical context for order stoppage..."
              rows={3}
              className="w-full text-xs p-2 rounded border border-ink-200 bg-surface text-ink-900 focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
        </div>
      </Drawer>

      {/* Verbal Order Co-Sign / Reject Drawer */}
      {activeVerbalAction && (
        <Drawer
          isOpen={true}
          onClose={() => setActiveVerbalAction(null)}
          title={
            activeVerbalAction.type === 'cosign'
              ? 'Co-Sign Verbal Order'
              : 'Reject Verbal Order'
          }
          size="sm"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveVerbalAction(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={async () => {
                  try {
                    setIsSubmitting(true);
                    setVerbalActionError(null);
                    if (activeVerbalAction.type === 'cosign') {
                      await cosignVerbalOrderAction({
                        orderId: activeVerbalAction.order.id,
                        notes: verbalActionNotes.trim() || undefined,
                      });
                      setVerbalSuccessMsg(
                        `Verbal order for ${activeVerbalAction.order.medicineName} co-signed successfully.`,
                      );
                    } else {
                      if (!verbalActionNotes || verbalActionNotes.trim().length < 5) {
                        setVerbalActionError(
                          'A clinical rationale (at least 5 characters) is required to reject a verbal order.',
                        );
                        return;
                      }
                      await rejectVerbalOrderAction({
                        orderId: activeVerbalAction.order.id,
                        rejectionReason: verbalActionNotes.trim(),
                      });
                      setVerbalSuccessMsg(
                        `Verbal order for ${activeVerbalAction.order.medicineName} has been rejected.`,
                      );
                    }
                    setActiveVerbalAction(null);
                    setTimeout(() => setVerbalSuccessMsg(null), 4000);
                  } catch (err: any) {
                    setVerbalActionError(err?.message || 'Action failed.');
                  } finally {
                    setIsSubmitting(false);
                  }
                }}
                className={`px-4 py-1.5 text-xs font-semibold rounded text-white min-h-[44px] ${
                  activeVerbalAction.type === 'cosign'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-rose-600 hover:bg-rose-700'
                }`}
              >
                {isSubmitting
                  ? 'Processing...'
                  : activeVerbalAction.type === 'cosign'
                  ? 'Confirm Co-Sign'
                  : 'Confirm Rejection'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="rounded bg-ink-50 p-3 text-xs space-y-1">
              <div className="font-bold text-ink-900 text-sm">
                {activeVerbalAction.order.medicineName}
              </div>
              <div className="text-ink-600">
                Dose: <strong>{activeVerbalAction.order.doseAmount} {activeVerbalAction.order.doseUnit}</strong> ({activeVerbalAction.order.route})
              </div>
              <div className="text-ink-500">
                Attributed Authority: <strong>{activeVerbalAction.order.verbalDoctorName ? `Dr. ${activeVerbalAction.order.verbalDoctorName}` : 'Urgent Verbal Protocol'}</strong>
              </div>
              {activeVerbalAction.order.verbalClinicalRationale && (
                <div className="text-ink-500 italic">
                  Rationale: “{activeVerbalAction.order.verbalClinicalRationale}”
                </div>
              )}
            </div>

            {verbalActionError && (
              <div className="rounded bg-rose-50 border border-rose-200 p-2.5 text-xs text-rose-800">
                {verbalActionError}
              </div>
            )}

            <div>
              <label className="block text-xs font-semibold text-ink-800 mb-1">
                {activeVerbalAction.type === 'cosign'
                  ? 'Physician Co-Sign Notes (Optional)'
                  : 'Rejection Clinical Rationale (Required - min 5 chars)'}
              </label>
              <textarea
                value={verbalActionNotes}
                onChange={(e) => setVerbalActionNotes(e.target.value)}
                placeholder={
                  activeVerbalAction.type === 'cosign'
                    ? 'Confirming telephonic authorization given to on-duty nurse...'
                    : 'State why verbal order was rejected...'
                }
                rows={3}
                className="w-full text-xs p-2 rounded border border-ink-200 bg-surface text-ink-900 focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
        </Drawer>
      )}

      {/* Draft Order Rejection Drawer */}
      {activeRejectDraft && (
        <Drawer
          isOpen={true}
          onClose={() => setActiveRejectDraft(null)}
          title="Reject Draft OPD Order"
          patient={{
            name: patientName,
            uhid,
            bedLabel,
          }}
          size="sm"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveRejectDraft(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDraftSubmitting}
                onClick={handleConfirmRejectDraft}
                className="px-4 py-1.5 text-xs font-semibold rounded text-white bg-rose-600 hover:bg-rose-700 min-h-[44px]"
              >
                {isDraftSubmitting ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="rounded bg-ink-50 p-3 text-xs space-y-1">
              <div className="font-bold text-ink-900 text-sm">
                {activeRejectDraft.medicineName}
              </div>
              <div className="text-ink-600">
                Dose: <strong>{activeRejectDraft.doseAmount} {activeRejectDraft.doseUnit}</strong> ({activeRejectDraft.route}) · {activeRejectDraft.frequencyCode}
              </div>
              <div className="text-ink-500">
                Origin: Outpatient Prescription
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-800 mb-1">
                Clinical Reason for Rejection (Required - min 3 chars)
              </label>
              <textarea
                value={rejectDraftReason}
                onChange={(e) => setRejectDraftReason(e.target.value)}
                placeholder="e.g. Switched to IV formulation, duplicate therapy, discontinued clinically..."
                rows={3}
                className="w-full text-xs p-2 rounded border border-ink-200 bg-surface text-ink-900 focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
        </Drawer>
      )}

      {/* Allergy Conflict Override Drawer */}
      {activeAllergyDraft && (
        <Drawer
          isOpen={true}
          onClose={() => setActiveAllergyDraft(null)}
          title="Allergy Warning & Clinical Override"
          patient={{
            name: patientName,
            uhid,
            bedLabel,
          }}
          size="sm"
          footer={
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setActiveAllergyDraft(null)}
                className="px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isDraftSubmitting || activeAllergyDraft.overrideReason.trim().length < 5}
                onClick={() => handleApproveDraft(activeAllergyDraft.order, activeAllergyDraft.overrideReason)}
                className="px-4 py-1.5 text-xs font-semibold rounded text-white bg-amber-600 hover:bg-amber-700 min-h-[44px] disabled:opacity-50"
              >
                {isDraftSubmitting ? 'Overriding...' : 'Approve with Override'}
              </button>
            </div>
          }
        >
          <div className="space-y-4">
            <div className="rounded bg-rose-50 border border-rose-200 p-3 text-xs space-y-1 text-rose-900">
              <div className="font-bold flex items-center gap-1.5">
                <AlertTriangleIcon className="size-4 text-rose-600" />
                <span>Documented Allergy Conflict</span>
              </div>
              <div>{activeAllergyDraft.conflictError}</div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-ink-800 mb-1">
                Clinical Override Reason (Required - min 5 chars)
              </label>
              <textarea
                value={activeAllergyDraft.overrideReason}
                onChange={(e) =>
                  setActiveAllergyDraft({
                    ...activeAllergyDraft,
                    overrideReason: e.target.value,
                  })
                }
                placeholder="Document clinical rationale for overriding documented allergy..."
                rows={3}
                className="w-full text-xs p-2 rounded border border-ink-200 bg-surface text-ink-900 focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </div>
          </div>
        </Drawer>
      )}

      {/* Prescribe & Treatment Plan Modal */}
      <CreateTreatmentPlanModal
        admissionId={admissionId}
        isOpen={isPrescribeModalOpen}
        onClose={() => setIsPrescribeModalOpen(false)}
        patientName={patientName}
        initialDiagnosis={initialDiagnosis}
        activeOrders={orders
          .filter((o) => o.status === 'active' || o.status === 'on_hold')
          .map((o) => ({
            id: o.id,
            medicineName: o.medicineName,
            route: o.route,
            frequency: o.frequencyCode,
          }))}
      />
    </div>
  );
}
