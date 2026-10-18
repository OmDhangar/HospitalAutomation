'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ipd/status-badge';
import { DischargeSummaryDrawer } from './discharge-summary-drawer';
import { CheckIcon, FileTextIcon, PrinterIcon } from '@/components/icons';

export interface DischargeTabProps {
  admissionId: string;
  status: string;
  canDischarge?: boolean;
  dischargeReadyAt?: string | Date | null;
  onToggleDischargeReady?: (ready: boolean) => Promise<void>;
  doctorName?: string;
  patientName?: string;
  bedLabel?: string;
  wardName?: string;
  dischargeMedicationsCount?: number;
  dischargeSummary?: any;
  homeMedications?: any[];
  attendingDoctor?: any;
  className?: string;
}

export function DischargeTab({
  admissionId,
  status,
  canDischarge = true,
  dischargeReadyAt,
  onToggleDischargeReady,
  doctorName,
  patientName,
  bedLabel,
  wardName,
  dischargeMedicationsCount = 0,
  dischargeSummary,
  homeMedications,
  attendingDoctor,
  className = '',
}: DischargeTabProps) {
  const [currentStatus, setCurrentStatus] = useState(status);
  const [isUpdating, setIsUpdating] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);
  const [pharmacyReturned, setPharmacyReturned] = useState(false);
  const [isSummaryDrawerOpen, setIsSummaryDrawerOpen] = useState(false);

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
    <div className={`space-y-4 ${className}`}>
      {/* Cockpit Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 border-b border-ink-200 pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-bold text-ink-950">Discharge Clearance Cockpit</h2>
            <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-ink-100 text-ink-700">
              Discharge Workflow
            </span>
          </div>
          <p className="text-xs text-ink-500">
            Coordinate medical clearance, return unused pharmacy medicines, settle final bills, and generate discharge summary.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/print/ipd-bill/draft?admissionId=${admissionId}&report=1`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-800 bg-surface hover:bg-ink-50 shadow-2xs"
          >
            <PrinterIcon className="size-3.5" />
            <span>Print Discharge Card</span>
          </Link>
        </div>
      </div>

      {feedbackMessage && (
        <div className="p-2.5 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-md">
          {feedbackMessage}
        </div>
      )}

      {/* 4-Step Clearance Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
        {/* Step 1: Medical Clearance */}
        <div className="bg-surface p-3.5 rounded border border-ink-200/80 shadow-2xs space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
                  1
                </span>
                <h3 className="text-xs font-bold text-ink-900">
                  Medical Clearance &amp; Fit-to-Leave
                </h3>
              </div>
              <p className="text-2xs text-ink-500 mt-1">
                Doctor certifies the patient is clinically stable and ready to leave the ward.
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

          <div className="pt-2 border-t border-ink-100 text-xs text-ink-700 space-y-2">
            {doctorName && (
              <div className="text-2xs text-ink-600">
                Primary Consultant: <span className="font-semibold text-ink-900">{doctorName}</span>
              </div>
            )}

            {!isDischarged && (
              <div>
                {isReady ? (
                  <div className="flex items-center justify-between gap-2 bg-emerald-50/70 p-2 rounded border border-emerald-200/70">
                    <div className="flex items-center gap-1.5 text-xs text-emerald-800 font-semibold">
                      <CheckIcon className="size-4 text-emerald-600" />
                      <span>Patient is marked ready for discharge.</span>
                    </div>
                    {canDischarge && (
                      <button
                        type="button"
                        disabled={isUpdating}
                        onClick={() => handleToggle(false)}
                        className="px-2.5 py-1 text-2xs font-semibold rounded border border-ink-200 text-ink-700 bg-surface hover:bg-ink-50"
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
                    className="w-full py-2 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs"
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

        {/* Step 2: Pharmacy Reconciliation */}
        <div className="bg-surface p-3.5 rounded border border-ink-200/80 shadow-2xs space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
                  2
                </span>
                <h3 className="text-xs font-bold text-ink-900">
                  Pharmacy Reconciliation &amp; Return
                </h3>
              </div>
              <p className="text-2xs text-ink-500 mt-1">
                Return unused medications to pharmacy so patient is not over-billed.
              </p>
            </div>
            <span
              className={`text-2xs font-bold px-2 py-0.5 rounded ${pharmacyReturned
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-100 text-amber-800'
                }`}
            >
              {pharmacyReturned ? 'Returned' : 'Check Bedside'}
            </span>
          </div>

          <div className="pt-2 border-t border-ink-100 text-xs text-ink-700 space-y-2">
            <label className="flex items-start gap-2 text-2xs text-ink-800 cursor-pointer p-2 rounded hover:bg-ink-50 border border-ink-100">
              <input
                type="checkbox"
                checked={pharmacyReturned}
                onChange={(e) => setPharmacyReturned(e.target.checked)}
                className="mt-0.5 rounded border-ink-300 text-primary focus:ring-primary size-3.5"
              />
              <span>
                All unconsumed IV ampoules, vials, and oral strips returned to inpatient pharmacy desk.
              </span>
            </label>
            <div className="text-2xs text-ink-500">
              Bedside stock balance zeroed out.
            </div>
          </div>
        </div>

        {/* Step 3: Final Bill Settlement */}
        <div className="bg-surface p-3.5 rounded border border-ink-200/80 shadow-2xs space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
                  3
                </span>
                <h3 className="text-xs font-bold text-ink-900">
                  Final Bill Settlement &amp; Clearance
                </h3>
              </div>
              <p className="text-2xs text-ink-500 mt-1">
                Review bed charges, consumables, tests, and reconcile deposit balance.
              </p>
            </div>
            <span className="text-2xs font-bold px-2 py-0.5 rounded bg-sky-100 text-sky-800">
              Billing Desk
            </span>
          </div>

          <div className="pt-2 border-t border-ink-100 text-xs text-ink-700 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Link
                href={`/ipd/admissions/${admissionId}/bill`}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-primary text-white hover:bg-primary/90 shadow-2xs"
              >
                <FileTextIcon className="size-3.5" />
                <span>Finalize Discharge Bill</span>
              </Link>
              <Link
                href={`/ipd/patients/${admissionId}/billing`}
                className="text-2xs font-semibold text-primary hover:underline"
              >
                View Running Ledger →
              </Link>
            </div>
            <p className="text-2xs text-ink-500">
              Settlement desk locks bill items and generates final tax invoice.
            </p>
          </div>
        </div>

        {/* Step 4: Discharge Summary & Card */}
        <div className="bg-surface p-3.5 rounded border border-ink-200/80 shadow-2xs space-y-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2">
                <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
                  4
                </span>
                <h3 className="text-xs font-bold text-ink-900">
                  Discharge Summary &amp; Patient Card
                </h3>
              </div>
              <p className="text-2xs text-ink-500 mt-1">
                Take-home medications, post-discharge diet, and follow-up consultation dates.
              </p>
            </div>
            <span
              className={`text-2xs font-bold px-2 py-0.5 rounded ${dischargeSummary?.status === 'finalized'
                  ? 'bg-emerald-100 text-emerald-800'
                  : dischargeSummary?.status === 'draft'
                    ? 'bg-amber-100 text-amber-800'
                    : 'bg-rose-100 text-rose-800'
                }`}
            >
              {dischargeSummary?.status === 'finalized'
                ? `Finalized (v${dischargeSummary.version})`
                : dischargeSummary?.status === 'draft'
                  ? 'Draft Summary'
                  : 'Pending Summary'}
            </span>
          </div>

          <div className="pt-2 border-t border-ink-100 text-xs text-ink-700 space-y-2">
            <div className="flex items-center justify-between text-2xs text-ink-600 bg-ink-50/70 p-2 rounded border border-ink-100">
              <span>Take-Home Prescriptions:</span>
              <span className="font-bold text-ink-900">
                {`${dischargeSummary?.takeHomePrescriptions?.length ?? dischargeMedicationsCount} take-home medications`}
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setIsSummaryDrawerOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand-600 text-white hover:bg-brand-700 shadow-2xs"
              >
                <FileTextIcon className="size-3.5" />
                <span>{dischargeSummary?.status === 'finalized' ? 'View Final Summary' : 'Edit & Finalize Summary'}</span>
              </button>
              <Link
                href={`/print/ipd-bill/draft?admissionId=${admissionId}&report=1`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-800 bg-surface hover:bg-ink-50 shadow-2xs"
              >
                <PrinterIcon className="size-3.5" />
                <span>Print Card</span>
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Discharge Summary Versioned Drawer */}
      <DischargeSummaryDrawer
        admissionId={admissionId}
        isOpen={isSummaryDrawerOpen}
        onClose={() => setIsSummaryDrawerOpen(false)}
        patientName={patientName ?? 'Patient'}
        initialSummary={dischargeSummary}
        homeMedications={homeMedications}
        attendingDoctor={attendingDoctor}
      />
    </div>
  );
}
