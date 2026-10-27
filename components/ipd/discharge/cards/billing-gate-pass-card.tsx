'use client';

import React from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ipd/status-badge';
import { FileTextIcon, PrinterIcon } from '@/components/icons';

export interface BillingGatePassCardProps {
  admissionId: string;
  isSettled: boolean;
  gatePassNumber?: string | null;
  gatePassIssuedAt?: string | Date | null;
  canIssueGatePass: boolean;
  onOpenGatePassModal: () => void;
}

export function BillingGatePassCard({
  admissionId,
  isSettled,
  gatePassNumber,
  gatePassIssuedAt,
  canIssueGatePass,
  onOpenGatePassModal,
}: BillingGatePassCardProps) {
  const isGatePassIssued = Boolean(gatePassNumber);

  return (
    <div className="bg-surface p-4 rounded-xl border border-ink-200/80 shadow-2xs space-y-3.5 flex flex-col justify-between md:col-span-2">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
              5
            </span>
            <h3 className="text-xs font-bold text-ink-900">Billing Settlement &amp; Gate Pass</h3>
          </div>
          <StatusBadge
            status={
              isGatePassIssued
                ? 'Gate Pass Active'
                : isSettled
                  ? 'Settled & Cleared'
                  : 'Pending Settlement'
            }
            variant={isGatePassIssued ? 'green' : isSettled ? 'blue' : 'amber'}
          />
        </div>

        <p className="text-2xs text-ink-500">
          Audit room rent, pharmacy returns, consumables, and reconcile advance deposits before generating exit Gate Pass.
        </p>

        <div className="pt-2 border-t border-ink-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 text-2xs">
          {/* Gate Pass Status display */}
          <div className="p-2.5 bg-ink-50/80 rounded-lg border border-ink-200 flex items-center gap-3">
            <div className="size-8 rounded-full bg-primary/10 text-primary flex items-center justify-center font-bold">
              GP
            </div>
            <div>
              <span className="text-3xs text-ink-500 block">Discharge Gate Pass:</span>
              <span className="font-mono font-bold text-xs text-ink-900">
                {gatePassNumber ? gatePassNumber : canIssueGatePass ? 'Ready to Issue' : 'Clearances Pending'}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-3">
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
        </div>
      </div>

      <div className="pt-2 border-t border-ink-100 flex items-center justify-between gap-2">
        <p className="text-2xs text-ink-500">
          {isGatePassIssued
            ? 'Exit Gate Pass generated and verified at security gate checkpoint.'
            : 'Gate Pass requires Medical, Pharmacy, Nursing, Summary, and Billing sign-offs.'}
        </p>

        <button
          type="button"
          onClick={onOpenGatePassModal}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded border border-ink-300 text-ink-800 bg-surface hover:bg-ink-50 shadow-2xs whitespace-nowrap"
        >
          <PrinterIcon className="size-3.5" />
          <span>{isGatePassIssued ? 'View Gate Pass' : 'Gate Pass Checkpoint'}</span>
        </button>
      </div>
    </div>
  );
}
