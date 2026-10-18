import React from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui';
import { BedIcon } from '@/components/icons';
import { dayOfStay } from '@/lib/domain/admission';
import { AdmissionStatusChip } from '@/components/ipd/patient-header';
import type { IpdStatus } from '@/lib/services/ipd-census';

export interface CompactPatientBarProps {
  name: string;
  age: number | null;
  gender: string | null;
  phoneE164?: string | null;
  bed: { label: string; wardName: string } | null;
  admittedAt: Date | null;
  doctorName: string;
  status: IpdStatus | 'discharged' | 'cancelled';
  timezone: string;
  now?: Date;
  ipdNumber?: number | null;
  backHref?: string;
  backLabel?: string;
  actions?: React.ReactNode;
  allergyStatus?: 'unreviewed' | 'nkda' | 'allergies_documented';
  className?: string;
}

/**
 * High-density universal patient bar (IPD Redesign §5.1, §8.1).
 * Replaces stacked headers with a streamlined, sticky ~50px banner.
 */
export function CompactPatientBar({
  name,
  age,
  gender,
  bed,
  admittedAt,
  doctorName,
  status,
  timezone,
  now = new Date(),
  ipdNumber = null,
  backHref = '/ipd',
  backLabel = '← IPD',
  actions,
  allergyStatus,
  className,
}: CompactPatientBarProps) {
  const ageSex = [age !== null ? String(age) : null, gender ? gender[0].toUpperCase() : null]
    .filter(Boolean)
    .join(' ');

  const cleanDocName = doctorName ? `Dr. ${doctorName.replace(/^Dr\.?\s*/i, '')}` : '';
  const currentStayDay = admittedAt && status !== 'discharged' ? dayOfStay(admittedAt, now, timezone) : null;

  return (
    <div
      className={cn(
        'sticky top-0 z-30 flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-ink-200 bg-white/95 px-3.5 py-2 shadow-xs backdrop-blur-xs sm:px-4',
        className,
      )}
    >
      {/* Left: Back Breadcrumb + Bed Pill + Core Patient Identity */}
      <div className="flex min-w-0 flex-wrap items-center gap-2 sm:gap-3">
        {backHref && (
          <Link
            href={backHref}
            className="inline-flex min-h-9 items-center text-xs font-semibold text-ink-500 hover:text-ink-900"
          >
            {backLabel}
          </Link>
        )}

        <div className="h-4 w-px bg-ink-200" aria-hidden="true" />

        {/* Bed Location Badge */}
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded-md px-2 py-0.5 font-mono text-xs font-bold ring-1 ring-inset',
            bed
              ? 'bg-brand-50 text-brand-900 ring-brand-300'
              : 'bg-ink-100 text-ink-600 ring-ink-200',
          )}
        >
          <BedIcon className="size-3.5 text-brand-700" />
          {bed ? `${bed.wardName} · Bed ${bed.label}` : 'No bed yet'}
        </span>

        {/* Patient Name & Demographics */}
        <div className="flex min-w-0 items-baseline gap-1.5">
          <h1 className="truncate text-sm font-bold text-ink-950 sm:text-base">
            {name}
          </h1>
          {ageSex && (
            <span className="shrink-0 text-xs text-ink-600">
              · {ageSex}
            </span>
          )}
          {ipdNumber !== null && (
            <span className="shrink-0 font-mono text-xs text-ink-500">
              {`· IPD #${ipdNumber}`}
            </span>
          )}
          {currentStayDay !== null && (
            <span className="shrink-0 text-xs font-medium text-ink-600">
              {`· Day ${currentStayDay}`}
            </span>
          )}
          {cleanDocName && (
            <span className="hidden shrink-0 text-xs text-ink-600 md:inline">
              {`· ${cleanDocName}`}
            </span>
          )}
        </div>

        {/* Optional Allergy Indicator */}
        {allergyStatus === 'allergies_documented' && (
          <span className="rounded bg-rose-100 px-1.5 py-0.5 text-[11px] font-bold text-rose-800 ring-1 ring-rose-300">
            ⚠️ Allergies
          </span>
        )}
      </div>

      {/* Right: Status Chip + Action Buttons */}
      <div className="flex shrink-0 items-center gap-2">
        <AdmissionStatusChip status={status} />
        {actions && (
          <div className="flex items-center gap-1.5 pl-1.5 sm:border-l sm:border-ink-200">
            {actions}
          </div>
        )}
      </div>
    </div>
  );
}
