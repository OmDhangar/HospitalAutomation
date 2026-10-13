'use client';

import React, { useState } from 'react';
import { Drawer } from '@/components/ipd/drawer';
import { StatusBadge } from '@/components/ipd/status-badge';
import { StopReasons, type StopReason } from '@/constants/clinical';
import { CreateTreatmentPlanModal } from '@/components/ipd/prescriptions/create-treatment-plan-modal';
import { PlusIcon } from '@/components/icons';

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

      {/* Prescribe & Treatment Plan Modal */}
      <CreateTreatmentPlanModal
        admissionId={admissionId}
        isOpen={isPrescribeModalOpen}
        onClose={() => setIsPrescribeModalOpen(false)}
        patientName={patientName}
        initialDiagnosis={initialDiagnosis}
      />
    </div>
  );
}
