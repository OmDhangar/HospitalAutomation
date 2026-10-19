'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CheckIcon, BedIcon } from '@/components/icons';
import { Button } from '@/components/ui';

export interface IntakeSuccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  result: {
    admissionId: string;
    admissionNumber: string;
    patientName: string;
    receiptNumber: string | null;
    mlcNumber: string | null;
    isIntakeComplete: boolean;
    bedLabel?: string;
    wardName?: string;
  };
}

export function IntakeSuccessModal({ isOpen, onClose, result }: IntakeSuccessModalProps) {
  const router = useRouter();
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/50 p-4 backdrop-blur-xs">
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-ink-950/10 dark:bg-ink-900">
        {/* Success Header */}
        <div className="text-center">
          <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
            <CheckIcon className="size-8" />
          </div>
          <h2 className="mt-3 text-xl font-bold text-ink-900 dark:text-ink-50">
            Patient Admitted Successfully
          </h2>
          <p className="mt-1 text-sm text-ink-600 dark:text-ink-400">
            {result.patientName} has been admitted to IPD.
          </p>
        </div>

        {/* Admission Details Card */}
        <div className="mt-5 rounded-xl border border-ink-200 bg-ink-50/50 p-4 space-y-2 dark:border-ink-800 dark:bg-ink-800/40">
          <div className="flex items-center justify-between text-sm">
            <span className="text-ink-600 dark:text-ink-400">Admission No:</span>
            <span className="font-mono font-bold text-ink-900 dark:text-ink-100">{result.admissionNumber}</span>
          </div>

          {result.wardName && result.bedLabel && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-600 dark:text-ink-400">Bed Allocation:</span>
              <span className="font-semibold text-brand-700 dark:text-brand-300">
                {result.wardName} · Bed {result.bedLabel}
              </span>
            </div>
          )}

          {result.receiptNumber && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-ink-600 dark:text-ink-400">Deposit Receipt No:</span>
              <span className="font-mono font-bold text-ink-900 dark:text-ink-100">{result.receiptNumber}</span>
            </div>
          )}

          {result.mlcNumber && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-rose-700 dark:text-rose-400 font-medium">MLC Record No:</span>
              <span className="font-mono font-bold text-rose-800 dark:text-rose-300">{result.mlcNumber}</span>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-ink-200/60 pt-2 text-xs">
            <span className="text-ink-500">Intake Paperwork:</span>
            <span className={result.isIntakeComplete ? 'text-emerald-600 font-semibold' : 'text-amber-600 font-semibold'}>
              {result.isIntakeComplete ? '✓ Paperwork Complete' : '⚠️ Pending Paperwork Flagged on Chart'}
            </span>
          </div>
        </div>

        {/* Quick Print Pack Actions */}
        <div className="mt-5 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-500">
            A4 Print Pack
          </p>
          <div className="grid grid-cols-2 gap-2">
            <a
              href={`/print/ipd-admission/${result.admissionId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-ink-200 bg-white p-2.5 text-xs font-semibold text-ink-800 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-200"
            >
              📄 Print Admission Sheet
            </a>

            <a
              href={`/print/ipd-admission/${result.admissionId}?section=consent`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-1.5 rounded-lg border border-ink-200 bg-white p-2.5 text-xs font-semibold text-ink-800 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-200"
            >
              ⚖️ Print Consent Form
            </a>
          </div>
        </div>

        {/* Footer Navigation */}
        <div className="mt-6 flex items-center justify-between border-t border-ink-100 pt-4 dark:border-ink-800">
          <Button
            type="button"
            variant="secondary"
            size="md"
            onClick={() => {
              onClose();
              router.push('/ipd');
            }}
          >
            Back to IPD List
          </Button>

          <Link href={`/ipd/admissions/${result.admissionId}`}>
            <Button variant="primary" size="md" className="gap-2">
              <BedIcon className="size-4" />
              Open Patient Chart
            </Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
