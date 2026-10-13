'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ipd/status-badge';
import { CheckIcon, FileTextIcon } from '@/components/icons';

export interface DischargeTabProps {
  admissionId: string;
  status: string;
  canDischarge?: boolean;
  dischargeReadyAt?: string | Date | null;
  onToggleDischargeReady?: (ready: boolean) => Promise<void>;
  className?: string;
}

export function DischargeTab({
  admissionId,
  status,
  canDischarge = true,
  dischargeReadyAt,
  onToggleDischargeReady,
  className = '',
}: DischargeTabProps) {
  const [currentStatus, setCurrentStatus] = useState(status);
  const [isUpdating, setIsUpdating] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  const isReady = currentStatus === 'discharge_ready';
  const isDischarged = currentStatus === 'discharged';

  const handleToggle = async (newReady: boolean) => {
    setIsUpdating(true);
    setFeedbackMessage(null);
    try {
      if (onToggleDischargeReady) {
        await onToggleDischargeReady(newReady);
      }
      setCurrentStatus(newReady ? 'discharge_ready' : 'admitted');
      setFeedbackMessage(
        newReady
          ? 'Patient marked ready for discharge.'
          : 'Discharge readiness cleared. Patient returned to admitted status.',
      );
    } catch (err: any) {
      setFeedbackMessage(err?.message || 'Failed to update discharge readiness.');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className={`space-y-6 ${className}`}>
      {/* Header */}
      <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs">
        <h2 className="text-base font-semibold text-ink-900">Discharge Workflow</h2>
        <p className="text-xs text-ink-500 mt-1">
          Coordinate patient discharge readiness, pharmacy reconciliations, discharge summary sign-off, and final billing.
        </p>
      </div>

      {feedbackMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-md">
          {feedbackMessage}
        </div>
      )}

      {/* Step 1: Medical Clearance / Discharge Readiness */}
      <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              1. Consultant Medical Clearance
            </h3>
            <p className="text-xs text-ink-500 mt-0.5">
              Doctor marks patient medically fit to leave the hospital.
            </p>
          </div>
          <StatusBadge
            status={
              isDischarged
                ? 'Discharged'
                : isReady
                  ? 'Ready for discharge'
                  : 'Admitted'
            }
            variant={isDischarged ? 'grey' : isReady ? 'green' : 'blue'}
          />
        </div>

        <div className="pt-2 border-t border-ink-100">
          {!isDischarged && (
            <div>
              {isReady ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1.5 text-xs text-emerald-700 font-semibold">
                    <CheckIcon className="size-4" />
                    <span>Patient is marked ready for discharge.</span>
                  </div>
                  {canDischarge && (
                    <button
                      type="button"
                      disabled={isUpdating}
                      onClick={() => handleToggle(false)}
                      className="px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[36px]"
                    >
                      {isUpdating ? 'Updating...' : 'Undo Readiness'}
                    </button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  disabled={isUpdating || !canDischarge}
                  onClick={() => handleToggle(true)}
                  className="px-4 py-2 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 min-h-[44px]"
                >
                  {isUpdating ? 'Updating...' : 'Mark Ready for Discharge'}
                </button>
              )}
            </div>
          )}

          {isDischarged && (
            <p className="text-xs text-ink-600 font-medium">
              This patient stay has been finalized and discharged.
            </p>
          )}
        </div>
      </div>

      {/* Step 2: Finalize Discharge Bill */}
      <div className="bg-surface p-5 rounded-lg border border-ink-100 shadow-xs space-y-4">
        <div>
          <h3 className="text-sm font-semibold text-ink-900">
            2. Discharge Billing & Financial Clearance
          </h3>
          <p className="text-xs text-ink-500 mt-0.5">
            Review room charges, medicines administered, diagnostic tests, apply corporate or TPA approvals, and finalize the discharge bill.
          </p>
        </div>

        <div className="pt-2 border-t border-ink-100 flex items-center gap-3">
          <Link
            href={`/ipd/admissions/${admissionId}/bill`}
            className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded bg-primary text-white hover:bg-primary/90 min-h-[44px]"
          >
            <FileTextIcon className="size-4" />
            <span>Finalize Discharge Bill</span>
          </Link>
          <span className="text-xs text-ink-400">
            Navigates to itemized ledger and settlement desk.
          </span>
        </div>
      </div>
    </div>
  );
}
