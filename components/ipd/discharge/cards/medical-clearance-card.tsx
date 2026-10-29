'use client';

import React from 'react';
import { StatusBadge } from '@/components/ipd/status-badge';
import { CheckIcon, FileTextIcon } from '@/components/icons';

export interface MedicalClearanceCardProps {
  doctorName?: string;
  isReady: boolean;
  isDischarged: boolean;
  dischargeType?: string;
  clinicalFitAt?: string | Date | null;
  clinicalStabilityNotes?: string | null;
  canDischarge?: boolean;
  isUpdating?: boolean;
  onOpenModal: () => void;
  onQuickToggle: (ready: boolean) => void;
}

export function MedicalClearanceCard({
  doctorName,
  isReady,
  isDischarged,
  dischargeType = 'regular',
  clinicalFitAt,
  clinicalStabilityNotes,
  canDischarge = true,
  isUpdating = false,
  onOpenModal,
  onQuickToggle,
}: MedicalClearanceCardProps) {
  const typeLabels: Record<string, string> = {
    regular: 'Regular Discharge',
    dama: 'DAMA (Against Advice)',
    lama: 'LAMA (Left Against Advice)',
    transfer: 'Transfer to Higher Center',
    absconded: 'Absconded',
    death: 'Expired',
  };

  return (
    <div className="bg-surface p-4 rounded-xl border border-ink-200/80 shadow-2xs space-y-3.5 flex flex-col justify-between">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
              1
            </span>
            <h3 className="text-xs font-bold text-ink-900">Medical Clearance &amp; Fit-to-Leave</h3>
          </div>
          <StatusBadge
            status={
              isDischarged
                ? 'Discharged'
                : isReady
                  ? 'Fit to Discharge'
                  : 'Admitted'
            }
            variant={isDischarged ? 'grey' : isReady ? 'green' : 'blue'}
          />
        </div>

        <p className="text-2xs text-ink-500">
          Doctor certifies clinical stability, afebrile status, and discharge classification.
        </p>

        <div className="pt-2 border-t border-ink-100 text-2xs space-y-1.5">
          {doctorName && (
            <div className="text-ink-600">
              Primary Consultant: <span className="font-bold text-ink-900">{doctorName}</span>
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-ink-500">Classification:</span>
            <span className="font-semibold px-2 py-0.5 rounded bg-ink-100 text-ink-800 text-3xs uppercase tracking-wide">
              {typeLabels[dischargeType] ?? dischargeType}
            </span>
          </div>

          {clinicalStabilityNotes && (
            <div className="p-2 bg-ink-50 rounded border border-ink-200 text-ink-700 italic">
              &ldquo;{clinicalStabilityNotes}&rdquo;
            </div>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-ink-100">
        {!isDischarged ? (
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={isUpdating || !canDischarge}
              onClick={onOpenModal}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border border-ink-300 text-ink-800 bg-surface hover:bg-ink-50 shadow-2xs"
            >
              <FileTextIcon className="size-3.5" />
              <span>{isReady ? 'Edit Certification' : 'Certify Fit to Leave'}</span>
            </button>

            {isReady ? (
              <button
                type="button"
                disabled={isUpdating || !canDischarge}
                onClick={() => onQuickToggle(false)}
                className="px-2.5 py-1.5 text-2xs font-semibold rounded text-rose-700 hover:bg-rose-50"
              >
                Undo Readiness
              </button>
            ) : (
              <button
                type="button"
                disabled={isUpdating || !canDischarge}
                onClick={() => onQuickToggle(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs"
              >
                <CheckIcon className="size-3.5" />
                <span>Mark Ready for Discharge</span>
              </button>
            )}
          </div>
        ) : (
          <p className="text-2xs text-ink-500 font-medium">This stay has been finalized and discharged.</p>
        )}
      </div>
    </div>
  );
}
