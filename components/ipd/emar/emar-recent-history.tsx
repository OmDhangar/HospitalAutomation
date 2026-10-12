'use client';

import { useState } from 'react';
import { Button, cn } from '@/components/ui';
import type { SelectIpdMedicationAdministration } from '@/lib/db/schema';

export interface EmarRecentHistoryProps {
  history: SelectIpdMedicationAdministration[];
  onVoid?: (administrationId: string, reason: string) => Promise<void>;
  canVoid?: boolean;
  className?: string;
}

const OUTCOME_STYLES: Record<string, { label: string; className: string }> = {
  administered: { label: 'Administered', className: 'bg-emerald-100 text-emerald-800' },
  omitted: { label: 'Omitted', className: 'bg-amber-100 text-amber-800' },
  refused: { label: 'Refused', className: 'bg-rose-100 text-rose-800' },
  held: { label: 'Held', className: 'bg-violet-100 text-violet-800' },
};

function formatEventTime(date: Date | null): string {
  if (!date) return '—';
  const d = new Date(date);
  return d.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function EmarRecentHistory({
  history,
  onVoid,
  canVoid = false,
  className,
}: EmarRecentHistoryProps) {
  const [voidModalTarget, setVoidModalTarget] = useState<string | null>(null);
  const [voidReason, setVoidReason] = useState<string>('');
  const [isVoidPending, setIsVoidPending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConfirmVoid = async () => {
    if (!voidModalTarget || !onVoid) return;
    setErrorMsg(null);
    if (!voidReason.trim() || voidReason.trim().length < 3) {
      setErrorMsg('A structured reason (at least 3 characters) is required to void.');
      return;
    }

    setIsVoidPending(true);
    try {
      await onVoid(voidModalTarget, voidReason.trim());
      setVoidModalTarget(null);
      setVoidReason('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to void administration');
    } finally {
      setIsVoidPending(false);
    }
  };

  if (history.length === 0) {
    return (
      <div
        className={cn(
          'rounded-xl border border-dashed border-ink-300 bg-ink-50/50 p-8 text-center text-ink-600',
          className,
        )}
      >
        <p className="text-sm font-semibold text-ink-800">No recent medication activity</p>
        <p className="mt-1 text-xs text-ink-500">
          No doses or exceptions have been recorded in the past 24 hours for this patient.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className={cn('divide-y divide-ink-100 rounded-xl border border-ink-200 bg-white shadow-xs', className)}>
        {history.map((record) => {
          const isVoided = Boolean(record.voidedAt);
          const outcomeInfo = OUTCOME_STYLES[record.outcome] || {
            label: record.outcome,
            className: 'bg-ink-100 text-ink-700',
          };
          const displayTime = formatEventTime(record.actualTime || record.recordedAt);

          return (
            <div
              key={record.id}
              className={cn(
                'flex flex-col gap-2 p-3.5 transition sm:flex-row sm:items-center sm:justify-between',
                isVoided && 'bg-ink-50/70 opacity-60',
              )}
            >
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={cn(
                      'text-sm font-bold text-ink-900',
                      isVoided && 'line-through text-ink-400',
                    )}
                  >
                    {record.doseGiven || 'Medication dose'}
                  </span>
                  {record.routeGiven && (
                    <span className="rounded bg-ink-100 px-1.5 py-0.2 text-[10px] font-semibold uppercase text-ink-700">
                      {record.routeGiven.replace('_', ' ')}
                    </span>
                  )}
                  <span
                    className={cn(
                      'rounded-full px-2 py-0.5 text-[10px] font-bold uppercase',
                      outcomeInfo.className,
                    )}
                  >
                    {outcomeInfo.label}
                  </span>
                  {isVoided && (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800">
                      Voided: {record.voidReason || 'Error'}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs text-ink-500">
                  <div>
                    <span className="font-semibold text-ink-700">Time:</span> {displayTime}
                  </div>
                  {record.scheduledTime && (
                    <div>
                      <span className="font-semibold text-ink-700">Scheduled:</span>{' '}
                      {formatEventTime(record.scheduledTime)}
                    </div>
                  )}
                  {record.nonAdminReason && (
                    <div className="text-amber-800 font-medium">
                      <span className="font-semibold">Reason:</span> {record.nonAdminReason}
                    </div>
                  )}
                  {record.clinicalNote && (
                    <div className="italic">
                      Note: {record.clinicalNote}
                    </div>
                  )}
                </div>
              </div>

              {!isVoided && canVoid && onVoid && (
                <button
                  type="button"
                  onClick={() => {
                    setVoidModalTarget(record.id);
                    setVoidReason('');
                    setErrorMsg(null);
                  }}
                  className="shrink-0 self-start rounded-md border border-ink-200 px-2.5 py-1 text-xs font-semibold text-rose-700 hover:border-rose-300 hover:bg-rose-50 sm:self-center"
                >
                  Strike / Void
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Void Confirmation Modal */}
      {voidModalTarget && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
        >
          <div className="w-full max-w-md rounded-xl border border-ink-200 bg-white p-5 shadow-xl">
            <h3 className="text-base font-semibold text-ink-900">
              Void Administration Record
            </h3>
            <p className="mt-1 text-xs text-ink-500">
              Voiding strikes through the dose entry in legal audit history and reverses any associated billing lines.
            </p>

            {errorMsg && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
                {errorMsg}
              </div>
            )}

            <div className="mt-4">
              <label className="block text-xs font-medium text-ink-700">
                Mandatory Reason for Voiding <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Documented on wrong bed, Dose was withheld"
                value={voidReason}
                onChange={(e) => setVoidReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>

            <div className="mt-5 flex justify-end gap-2 border-t border-ink-100 pt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setVoidModalTarget(null)}
                disabled={isVoidPending}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={handleConfirmVoid}
                isLoading={isVoidPending}
              >
                Confirm Void
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
