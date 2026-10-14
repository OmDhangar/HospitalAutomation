'use client';

import React, { useState } from 'react';
import { Alert, Button } from '@/components/ui';
import { AlertTriangleIcon, ClockIcon } from '@/components/icons';
import type { GivenWithoutBillItem } from '@/lib/services/discharge-billing';

interface GivenWithoutBillModalProps {
  unbilledItems: GivenWithoutBillItem[];
  admissionId?: string;
  triggerButton?: React.ReactNode;
}

export function GivenWithoutBillModal({
  unbilledItems,
  admissionId,
  triggerButton,
}: GivenWithoutBillModalProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!unbilledItems || unbilledItems.length === 0) {
    return null;
  }

  const statusTone = (status: string | null) => {
    switch (status) {
      case 'failed':
        return 'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-300';
      case 'pending_pricing':
        return 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300';
      case 'pending':
        return 'bg-ink-100 text-ink-700 ring-1 ring-inset ring-ink-300';
      default:
        return 'bg-amber-100 text-amber-800 ring-1 ring-inset ring-amber-300';
    }
  };

  const statusLabel = (status: string | null) => {
    switch (status) {
      case 'failed':
        return 'Integration Failed';
      case 'pending_pricing':
        return 'Unpriced Formulary';
      case 'pending':
        return 'Pending Outbox';
      default:
        return 'Unposted Dose';
    }
  };

  return (
    <>
      {triggerButton ? (
        <span onClick={() => setIsOpen(true)}>{triggerButton}</span>
      ) : (
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-900 border border-amber-300 hover:bg-amber-100 transition-colors"
        >
          <AlertTriangleIcon className="h-4 w-4 text-amber-600" />
          <span>{unbilledItems.length} Unbilled Dose{unbilledItems.length > 1 ? 's' : ''} Given</span>
        </button>
      )}

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-2xs">
          <div className="w-full max-w-2xl rounded-2xl border border-ink-200 bg-white p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-ink-100 pb-3">
              <h3 className="text-base font-bold text-ink-950">Given-Without-Bill Audit</h3>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-ink-400 hover:text-ink-700 text-sm font-semibold"
              >
                ✕
              </button>
            </div>

            <Alert tone="warn">
              <div className="text-xs sm:text-sm">
                <strong>Bedside doses pending billing:</strong> The following medications were administered at the bedside by nursing staff, but have not yet been posted to the active bill lines. Review and resolve prior to discharge billing finalization.
              </div>
            </Alert>

            <div className="divide-y divide-ink-100 max-h-96 overflow-y-auto rounded-lg border border-ink-200 bg-white">
              {unbilledItems.map((item) => (
                <div key={item.administrationId} className="p-3.5 space-y-1.5 hover:bg-ink-50/50">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold text-ink-900 text-sm">
                        {item.medicineName}
                      </div>
                      <div className="text-xs text-ink-600 mt-0.5">
                        Dose: <span className="font-medium text-ink-800">{item.doseGiven ?? 'Standard dose'}</span> · Route: {item.routeGiven ?? 'Bedside'}
                      </div>
                    </div>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${statusTone(item.outboxStatus)}`}>
                      {statusLabel(item.outboxStatus)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-500 pt-1">
                    <span className="flex items-center gap-1">
                      <ClockIcon className="h-3.5 w-3.5 text-ink-400" />
                      Given {new Date(item.actualTime).toLocaleString('en-IN', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    {item.nurseName && (
                      <span>Nurse: <strong className="text-ink-700">{item.nurseName}</strong></span>
                    )}
                    {item.patientName && !admissionId && (
                      <span>Patient: <strong className="text-ink-700">{item.patientName}</strong> ({item.patientMrn ?? '—'})</span>
                    )}
                  </div>

                  {item.lastError && (
                    <div className="rounded bg-rose-50/80 p-2 text-xs text-rose-800 border border-rose-200 mt-2 font-mono">
                      Error: {item.lastError}
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="flex justify-between items-center pt-2">
              <span className="text-xs text-ink-500">
                Total unbilled administrations: <strong>{unbilledItems.length}</strong>
              </span>
              <Button type="button" variant="secondary" onClick={() => setIsOpen(false)}>
                Close Audit
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
