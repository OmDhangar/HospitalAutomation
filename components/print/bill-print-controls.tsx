'use client';

import React, { useEffect } from 'react';
import Link from 'next/link';

export interface BillPrintControlsProps {
  autoPrint?: boolean;
  includeReport: boolean;
  onToggleReport: (include: boolean) => void;
  backHref?: string;
  patientName?: string;
}

export function BillPrintControls({
  autoPrint = false,
  includeReport,
  onToggleReport,
  backHref,
  patientName,
}: BillPrintControlsProps) {
  useEffect(() => {
    if (autoPrint) {
      // Small timeout to allow styles & layout to render before browser dialog opens
      const timer = setTimeout(() => {
        window.print();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [autoPrint]);

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-ink-200 bg-white p-3.5 shadow-sm print:hidden">
      <div className="flex items-center gap-3">
        {backHref ? (
          <Link
            href={backHref}
            className="inline-flex items-center gap-1.5 rounded-lg border border-ink-200 bg-ink-50 px-3 py-1.5 text-xs font-semibold text-ink-800 hover:bg-ink-100 transition-colors"
          >
            ← Back{patientName ? ` to ${patientName}` : ''}
          </Link>
        ) : null}

        <label className="flex items-center gap-2 cursor-pointer rounded-lg border border-brand-200 bg-brand-50/50 px-3 py-1.5 text-xs font-bold text-brand-950 transition hover:bg-brand-50">
          <input
            type="checkbox"
            checked={includeReport}
            onChange={(e) => onToggleReport(e.target.checked)}
            className="size-4 rounded border-brand-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
          />
          <span>Include Lab &amp; Doctor Progress Report</span>
        </label>
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => window.print()}
          className="inline-flex items-center gap-2 rounded-xl bg-brand-700 px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-brand-800 cursor-pointer transition-all active:scale-[0.98]"
        >
          <span>🖨️ Print / Save as PDF</span>
        </button>
      </div>
    </div>
  );
}
