'use client';

import React from 'react';
import Link from 'next/link';
import { StatusBadge } from '@/components/ipd/status-badge';
import { FileTextIcon, PrinterIcon } from '@/components/icons';

export interface SummaryClearanceCardProps {
  admissionId: string;
  dischargeSummary?: any | null;
  takeHomeMedsCount?: number;
  onOpenSummaryDrawer: () => void;
}

export function SummaryClearanceCard({
  admissionId,
  dischargeSummary,
  takeHomeMedsCount = 0,
  onOpenSummaryDrawer,
}: SummaryClearanceCardProps) {
  const isFinalized = dischargeSummary?.status === 'finalized';
  const isDraft = dischargeSummary?.status === 'draft';

  return (
    <div className="bg-surface p-4 rounded-xl border border-ink-200/80 shadow-2xs space-y-3.5 flex flex-col justify-between">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
              4
            </span>
            <h3 className="text-xs font-bold text-ink-900">Discharge Summary &amp; Documentation</h3>
          </div>
          <StatusBadge
            status={
              isFinalized
                ? `Finalized (v${dischargeSummary.version ?? 1})`
                : isDraft
                  ? 'Draft Summary'
                  : 'Pending Summary'
            }
            variant={isFinalized ? 'green' : isDraft ? 'amber' : 'red'}
          />
        </div>

        <p className="text-2xs text-ink-500">
          Clinical course, operative summary, post-discharge diet, and follow-up consultation dates.
        </p>

        <div className="pt-2 border-t border-ink-100 text-2xs space-y-2">
          {dischargeSummary?.primaryDiagnosis && (
            <div className="p-2 rounded bg-ink-50/70 border border-ink-200/70">
              <span className="text-3xs text-ink-500 block">Primary Diagnosis:</span>
              <span className="font-semibold text-ink-900">{dischargeSummary.primaryDiagnosis}</span>
            </div>
          )}

          <div className="flex items-center justify-between p-2 rounded bg-ink-50/70 border border-ink-100">
            <span className="text-ink-600">Take-Home Prescriptions:</span>
            <span className="font-bold text-ink-900">
              {dischargeSummary?.takeHomePrescriptions?.length ?? takeHomeMedsCount} take-home medications
            </span>
          </div>

          {dischargeSummary?.followUpDate && (
            <div className="text-3xs text-ink-600">
              Follow-up Scheduled: <strong className="text-ink-900">{dischargeSummary.followUpDate}</strong>
            </div>
          )}
        </div>
      </div>

      <div className="pt-2 border-t border-ink-100 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onOpenSummaryDrawer}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded bg-brand-600 text-white hover:bg-brand-700 shadow-2xs"
        >
          <FileTextIcon className="size-3.5" />
          <span>{isFinalized ? 'View Final Summary' : 'Edit & Finalize Summary'}</span>
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
  );
}
