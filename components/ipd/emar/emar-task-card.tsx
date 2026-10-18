'use client';

import { cn } from '@/components/ui';
import type { BedsideDueItem, BedsidePrnItem } from '@/lib/services/ipd-emar';
import type { SelectIpdMedicationOrder } from '@/lib/db/schema';

export type TaskCardKind = 'scheduled' | 'prn' | 'onHold';

export interface EmarTaskCardProps {
  kind: TaskCardKind;
  dueItem?: BedsideDueItem;
  prnItem?: BedsidePrnItem;
  holdItem?: SelectIpdMedicationOrder;
  onAdminister?: (item: BedsideDueItem | BedsidePrnItem) => void;
  onException?: (item: BedsideDueItem) => void;
  className?: string;
}

function formatScheduledTime(date: Date): string {
  const d = new Date(date);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatRelativeSchedule(date: Date): { text: string; isPast: boolean } {
  const diffMins = Math.round((new Date(date).getTime() - Date.now()) / 60000);
  // 10-minute grace buffer: doses up to 10 minutes past scheduled time are on-time / due right now
  if (diffMins <= 0 && Math.abs(diffMins) <= 10) {
    return { text: 'Due right now (within 10m buffer)', isPast: false };
  }
  if (diffMins > 0 && diffMins < 5) return { text: 'Due right now', isPast: false };
  if (diffMins < -10) {
    const minsPast = Math.abs(diffMins);
    if (minsPast < 60) return { text: `${minsPast}m overdue`, isPast: true };
    const hrs = Math.floor(minsPast / 60);
    return { text: `${hrs}h ${minsPast % 60}m overdue`, isPast: true };
  }
  if (diffMins < 60) return { text: `in ${diffMins}m`, isPast: false };
  const hrs = Math.floor(diffMins / 60);
  return { text: `in ${hrs}h ${diffMins % 60}m`, isPast: false };
}

export function EmarTaskCard({
  kind,
  dueItem,
  prnItem,
  holdItem,
  onAdminister,
  onException,
  className,
}: EmarTaskCardProps) {
  if (kind === 'scheduled' && dueItem) {
    const isOverdue = dueItem.status === 'overdue';
    const isDueNow = dueItem.status === 'dueNow';
    const timing = formatRelativeSchedule(dueItem.scheduledTime);

    return (
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl border p-4 shadow-xs transition sm:flex-row sm:items-center sm:justify-between',
          isOverdue
            ? 'border-rose-300 bg-rose-50/50'
            : isDueNow
              ? 'border-emerald-300 bg-emerald-50/40'
              : 'border-ink-200 bg-white',
          className,
        )}
      >
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink-900">
              {dueItem.medicineName}
            </span>
            <span className="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-800">
              {dueItem.doseAmount} {dueItem.doseUnit}
            </span>
            <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ink-700">
              {dueItem.route.replace('_', ' ')}
            </span>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[11px] font-bold uppercase',
                isOverdue
                  ? 'bg-rose-100 text-rose-800 ring-1 ring-inset ring-rose-300'
                  : isDueNow
                    ? 'bg-emerald-100 text-emerald-900 ring-1 ring-inset ring-emerald-300'
                    : 'bg-brand-50 text-brand-800 ring-1 ring-inset ring-brand-200',
              )}
            >
              {isOverdue ? 'Overdue' : isDueNow ? 'Due Now' : 'Upcoming'}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600">
            <div>
              <span className="font-semibold text-ink-700">Slot:</span>{' '}
              <span className="font-mono font-bold text-ink-900">
                {formatScheduledTime(dueItem.scheduledTime)}
              </span>{' '}
              <span
                className={cn(
                  'font-medium',
                  timing.isPast ? 'text-rose-700' : 'text-ink-500',
                )}
              >
                ({timing.text})
              </span>
            </div>
            {dueItem.instructions && (
              <div className="italic text-ink-500">
                Note: {dueItem.instructions}
              </div>
            )}
          </div>
        </div>

        {/* Administration CTAs */}
        <div className="flex shrink-0 items-center gap-2">
          {onException && (
            <button
              type="button"
              onClick={() => onException(dueItem)}
              className="rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs font-semibold text-ink-700 shadow-xs transition hover:border-amber-400 hover:bg-amber-50 hover:text-amber-900"
            >
              Withhold / Omit
            </button>
          )}

          {onAdminister && (
            <button
              type="button"
              onClick={() => onAdminister(dueItem)}
              className={cn(
                'rounded-lg px-4 py-2 text-xs font-bold text-white shadow-xs transition',
                isOverdue
                  ? 'bg-rose-600 hover:bg-rose-700'
                  : 'bg-emerald-600 hover:bg-emerald-700',
              )}
            >
              ✓ Administer Dose
            </button>
          )}
        </div>
      </div>
    );
  }

  if (kind === 'prn' && prnItem) {
    const isEligible = prnItem.eligibility.eligible;
    const remainingDoses = prnItem.eligibility.dosesRemainingToday;
    const remainingQty = prnItem.eligibility.quantityRemainingToday;

    return (
      <div
        className={cn(
          'flex flex-col gap-3 rounded-xl border p-4 shadow-xs transition sm:flex-row sm:items-center sm:justify-between',
          isEligible ? 'border-sky-200 bg-sky-50/30' : 'border-ink-200 bg-ink-50/50',
          className,
        )}
      >
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink-900">
              {prnItem.medicineName}
            </span>
            <span className="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-800">
              {prnItem.doseAmount} {prnItem.doseUnit}
            </span>
            <span className="rounded-md bg-ink-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase text-ink-700">
              {prnItem.route.replace('_', ' ')}
            </span>
            <span className="rounded-full bg-sky-100 px-2 py-0.5 text-[11px] font-bold uppercase text-sky-800">
              PRN / SOS
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-600">
            {prnItem.prnIndication && (
              <div>
                <span className="font-semibold text-ink-700">Indication:</span>{' '}
                <span className="font-medium text-ink-900">{prnItem.prnIndication}</span>
              </div>
            )}
            {prnItem.prnMinIntervalHours && (
              <div>
                <span className="font-semibold text-ink-700">Min Gap:</span>{' '}
                {prnItem.prnMinIntervalHours}h
              </div>
            )}
            {remainingDoses !== undefined && (
              <div>
                <span className="font-semibold text-ink-700">Allowed Today:</span>{' '}
                {remainingDoses} doses remaining
              </div>
            )}
            {remainingQty !== undefined && prnItem.prnMaxDailyUnit && (
              <div>
                <span className="font-semibold text-ink-700">Cumulative Max:</span>{' '}
                {remainingQty} {prnItem.prnMaxDailyUnit} remaining
              </div>
            )}
          </div>

          {!isEligible && prnItem.eligibility.reason && (
            <p className="text-xs font-medium text-amber-700">
              ⚠️ Ineligible: {prnItem.eligibility.reason}
            </p>
          )}
        </div>

        {/* Administration CTA */}
        <div className="flex shrink-0 items-center gap-2">
          {onAdminister && (
            <button
              type="button"
              disabled={!isEligible}
              onClick={() => onAdminister(prnItem)}
              className="rounded-lg bg-sky-600 px-4 py-2 text-xs font-bold text-white shadow-xs transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:bg-ink-200 disabled:text-ink-400"
            >
              {isEligible ? 'Administer PRN' : 'In Cooldown / Limit Reached'}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (kind === 'onHold' && holdItem) {
    return (
      <div
        className={cn(
          'flex flex-col gap-2 rounded-xl border border-amber-200 bg-amber-50/50 p-4 shadow-xs sm:flex-row sm:items-center sm:justify-between',
          className,
        )}
      >
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-bold text-ink-900">
              {holdItem.medicineName}
            </span>
            <span className="rounded-md bg-ink-100 px-2 py-0.5 font-mono text-xs font-semibold text-ink-800">
              {holdItem.doseAmount} {holdItem.doseUnit}
            </span>
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-bold uppercase text-amber-800">
              Order On Hold
            </span>
          </div>
          <p className="text-xs text-amber-900">
            Dosing temporarily suspended by Attending Physician. No bedside administrations permitted.
          </p>
        </div>

        <span className="rounded-md border border-amber-300 bg-white px-2.5 py-1 text-xs font-semibold text-amber-900">
          Suspended
        </span>
      </div>
    );
  }

  return null;
}
