'use client';

import React, { useState } from 'react';
import { CheckIcon, PrinterIcon, XIcon } from '@/components/icons';
import type { DischargeClearanceStatus } from '@/lib/db/schema';

export interface GatePassModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  patientName?: string;
  mrn?: string;
  ipdNumber?: string;
  bedLabel?: string;
  wardName?: string;
  doctorName?: string;
  gatePassNumber?: string | null;
  issuedAt?: string | Date | null;
  clearanceStatus: DischargeClearanceStatus;
  onIssue: () => Promise<void>;
}

export function GatePassModal({
  isOpen,
  onClose,
  admissionId,
  patientName,
  mrn,
  ipdNumber,
  bedLabel,
  wardName,
  doctorName,
  gatePassNumber,
  issuedAt,
  clearanceStatus,
  onIssue,
}: GatePassModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const isIssued = Boolean(gatePassNumber);
  const canIssue = clearanceStatus.canIssueGatePass;

  const handleIssue = async () => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onIssue();
    } catch (err: any) {
      setError(err?.message || 'Failed to issue gate pass');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  const formattedDate = issuedAt
    ? new Date(issuedAt).toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : new Date().toLocaleString('en-IN', {
        dateStyle: 'medium',
        timeStyle: 'short',
      });

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-ink-950/40 backdrop-blur-xs flex items-center justify-center p-4 print:p-0 print:bg-white print:static"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-surface rounded-xl border border-ink-200 shadow-xl max-w-xl w-full overflow-hidden text-ink-900 animate-in fade-in zoom-in-95 duration-150 print:border-none print:shadow-none print:max-w-none">
        {/* Modal Top Nav (hidden on print) */}
        <div className="px-5 py-3 border-b border-ink-200 flex items-center justify-between print:hidden">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-ink-900">Hospital Discharge Exit Clearance</span>
            {isIssued ? (
              <span className="text-2xs font-bold px-2 py-0.5 rounded bg-emerald-100 text-emerald-800">
                Gate Pass Active
              </span>
            ) : canIssue ? (
              <span className="text-2xs font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">
                Ready for Issue
              </span>
            ) : (
              <span className="text-2xs font-bold px-2 py-0.5 rounded bg-rose-100 text-rose-800">
                Clearance Incomplete
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-100"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Status Warning if Incomplete */}
        {!canIssue && !isIssued && (
          <div className="m-4 p-3 bg-rose-50 border border-rose-200 text-rose-900 text-xs rounded-lg space-y-1.5 print:hidden">
            <div className="font-bold flex items-center gap-1.5">
              <span>⚠️ Clearance Incomplete ({clearanceStatus.completedCount} of 5 Completed)</span>
            </div>
            <p className="text-2xs text-rose-800">
              The exit gate pass cannot be generated until all 5 departments sign off:
            </p>
            <ul className="text-2xs list-disc list-inside space-y-0.5 text-rose-800">
              {!clearanceStatus.isMedicalCleared && <li>Medical Clearance pending consultant sign-off</li>}
              {!clearanceStatus.isPharmacyCleared && <li>Pharmacy bedside returns / MedRec pending</li>}
              {!clearanceStatus.isNursingCleared && <li>Nursing handover / invasive line removal checklist pending</li>}
              {!clearanceStatus.isSummaryFinalized && <li>Discharge Summary is still in draft</li>}
              {!clearanceStatus.isBillingCleared && <li>Final Bill Settlement pending clearance</li>}
            </ul>
          </div>
        )}

        {error && (
          <div className="mx-4 mt-4 p-2.5 bg-rose-50 border border-rose-200 text-rose-800 text-xs rounded-md">
            {error}
          </div>
        )}

        {/* Printable Gate Pass Body */}
        <div className="p-6 space-y-5 text-xs print:p-8">
          {/* Header */}
          <div className="text-center border-b-2 border-ink-950 pb-4">
            <h1 className="text-base font-extrabold tracking-wide uppercase text-ink-950">
              PATIENT DISCHARGE EXIT GATE PASS
            </h1>
            <p className="text-2xs text-ink-600 mt-0.5 font-semibold">
              Hospital Inpatient Department · Security Gate Checkpoint Copy
            </p>
            <div className="flex items-center justify-between text-2xs mt-3 pt-2 border-t border-ink-200">
              <span className="font-mono font-bold text-ink-950">
                PASS NO: {gatePassNumber || 'PENDING GENERATION'}
              </span>
              <span>ISSUED: {formattedDate}</span>
            </div>
          </div>

          {/* Patient Details Grid */}
          <div className="grid grid-cols-2 gap-3 p-3 bg-ink-50/70 rounded-lg border border-ink-200 text-2xs print:border-ink-400">
            <div>
              <span className="text-ink-500">Patient Name:</span>
              <div className="font-bold text-xs text-ink-950">{patientName || 'Patient'}</div>
            </div>
            <div>
              <span className="text-ink-500">UHID / MRN:</span>
              <div className="font-mono font-bold text-ink-950">{mrn || '—'}</div>
            </div>
            <div>
              <span className="text-ink-500">IPD Admission #:</span>
              <div className="font-mono font-bold text-ink-950">{ipdNumber || admissionId.slice(0, 8)}</div>
            </div>
            <div>
              <span className="text-ink-500">Ward &amp; Bed:</span>
              <div className="font-bold text-ink-950">{wardName ? `${wardName} · ${bedLabel ?? ''}` : bedLabel || 'Ward Bed'}</div>
            </div>
            <div className="col-span-2">
              <span className="text-ink-500">Primary Consultant:</span>
              <div className="font-bold text-ink-950">{doctorName || 'Attending Physician'}</div>
            </div>
          </div>

          {/* Department Clearance Table */}
          <div className="space-y-1.5">
            <span className="text-2xs font-bold text-ink-700 uppercase tracking-wider">
              Departmental Clearance Sign-offs
            </span>
            <table className="w-full text-2xs border border-ink-200 divide-y divide-ink-200">
              <thead className="bg-ink-100 text-ink-700 font-semibold">
                <tr>
                  <th className="px-2.5 py-1.5 text-left">Department</th>
                  <th className="px-2.5 py-1.5 text-center">Status</th>
                  <th className="px-2.5 py-1.5 text-left">Clearance Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-ink-100 bg-surface">
                <tr>
                  <td className="px-2.5 py-1.5 font-bold">1. Medical Clearance</td>
                  <td className="px-2.5 py-1.5 text-center font-bold text-emerald-700">
                    {clearanceStatus.isMedicalCleared ? 'CLEARED ✓' : 'PENDING'}
                  </td>
                  <td className="px-2.5 py-1.5 text-ink-600">Patient clinically fit to leave ward</td>
                </tr>
                <tr>
                  <td className="px-2.5 py-1.5 font-bold">2. Pharmacy Desk</td>
                  <td className="px-2.5 py-1.5 text-center font-bold text-emerald-700">
                    {clearanceStatus.isPharmacyCleared ? 'CLEARED ✓' : 'PENDING'}
                  </td>
                  <td className="px-2.5 py-1.5 text-ink-600">Bedside unconsumed stock returned &amp; counseled</td>
                </tr>
                <tr>
                  <td className="px-2.5 py-1.5 font-bold">3. Nursing Ward</td>
                  <td className="px-2.5 py-1.5 text-center font-bold text-emerald-700">
                    {clearanceStatus.isNursingCleared ? 'CLEARED ✓' : 'PENDING'}
                  </td>
                  <td className="px-2.5 py-1.5 text-ink-600">IV cannula/catheter removed &amp; belongings handed</td>
                </tr>
                <tr>
                  <td className="px-2.5 py-1.5 font-bold">4. Discharge Summary</td>
                  <td className="px-2.5 py-1.5 text-center font-bold text-emerald-700">
                    {clearanceStatus.isSummaryFinalized ? 'CLEARED ✓' : 'PENDING'}
                  </td>
                  <td className="px-2.5 py-1.5 text-ink-600">Clinical summary finalized &amp; copy provided</td>
                </tr>
                <tr>
                  <td className="px-2.5 py-1.5 font-bold">5. Billing / Cashier</td>
                  <td className="px-2.5 py-1.5 text-center font-bold text-emerald-700">
                    {clearanceStatus.isBillingCleared ? 'CLEARED ✓' : 'PENDING'}
                  </td>
                  <td className="px-2.5 py-1.5 text-ink-600">Accounts locked &amp; tax invoice settled</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Signature Boxes */}
          <div className="grid grid-cols-2 gap-6 pt-6 border-t border-ink-300 text-2xs">
            <div className="border-t border-ink-400 pt-1 text-center font-semibold text-ink-700">
              Ward Sister / Floor Coordinator
            </div>
            <div className="border-t border-ink-400 pt-1 text-center font-semibold text-ink-700">
              Security Gate Officer Signature
            </div>
          </div>
        </div>

        {/* Modal Footer Controls (hidden on print) */}
        <div className="px-5 py-3 bg-ink-50 border-t border-ink-200 flex items-center justify-between print:hidden">
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-semibold text-ink-600 hover:text-ink-900"
          >
            Close
          </button>

          <div className="flex items-center gap-2">
            {!isIssued && canIssue && (
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleIssue}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs"
              >
                <CheckIcon className="size-4" />
                <span>{isSubmitting ? 'Issuing...' : 'Generate & Issue Gate Pass'}</span>
              </button>
            )}

            {isIssued && (
              <button
                type="button"
                onClick={handlePrint}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded bg-primary text-white hover:bg-primary/90 shadow-2xs"
              >
                <PrinterIcon className="size-4" />
                <span>Print Gate Pass</span>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
