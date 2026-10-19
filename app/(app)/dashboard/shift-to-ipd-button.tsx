'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, cn } from '@/components/ui';
import { AlertCircleIcon, BedIcon, ClockIcon, XIcon } from '@/components/icons';
import { useToast } from '@/components/toast';
import { shiftToIpdDynamic, undoShiftToIpdDynamic } from './ipd-actions';

/** How long the Undo in the toast is offered; the server allows ten minutes. */
const UNDO_TOAST_MS = 10_000;

export interface ShiftToIpdButtonProps {
  appointmentId: string;
  patientName?: string;
  size?: 'sm' | 'md';
  /** On a Seen-today row: a small button that fits beside the Paid pill. */
  compact?: boolean;
  defaultDiagnosis?: string;
}

export function ShiftToIpdButton({
  appointmentId,
  patientName,
  size = 'md',
  compact = false,
  defaultDiagnosis,
}: ShiftToIpdButtonProps) {
  const toast = useToast();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [shifted, setShifted] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);

  // Admission advice form state
  const [urgency, setUrgency] = useState<'emergency' | 'same_day' | 'planned'>('same_day');
  const [advisedWardKind, setAdvisedWardKind] = useState<'general' | 'special' | 'hdu' | 'icu'>('general');
  const [reason, setReason] = useState(defaultDiagnosis || '');
  const [estimatedStayDays, setEstimatedStayDays] = useState<number | ''>(3);
  const [receptionNotes, setReceptionNotes] = useState('');

  const undo = (admissionId: string) => {
    startTransition(async () => {
      const res = await undoShiftToIpdDynamic({ admissionId });
      if (res.ok) {
        setShifted(false);
        toast.info('Shift to IPD undone');
        router.refresh();
      } else {
        toast.error('Could not undo', res.error);
      }
    });
  };

  const handleConfirmShift = () => {
    startTransition(async () => {
      const res = await shiftToIpdDynamic({
        appointmentId,
        urgency,
        advisedWardKind,
        reason: reason.trim() || null,
        estimatedStayDays: typeof estimatedStayDays === 'number' ? estimatedStayDays : null,
        receptionNotes: receptionNotes.trim() || null,
      });

      if (!res.ok) {
        toast.error('Could not shift to IPD', res.error);
        return;
      }

      setIsModalOpen(false);
      setShifted(true);
      toast.showToast(`${res.patientName} shifted to IPD — awaiting bed.`, {
        type: 'success',
        description: res.created ? 'Reception will assign the bed and complete intake.' : 'Already on the Awaiting bed list.',
        action: res.created ? { label: 'Undo', onClick: () => undo(res.admissionId) } : undefined,
        durationMs: res.created ? UNDO_TOAST_MS : 4000,
      });
      router.refresh();
    });
  };

  if (shifted) return <IpdBadge />;

  return (
    <>
      <Button
        type="button"
        size={compact ? 'sm' : size}
        variant="secondary"
        onClick={() => setIsModalOpen(true)}
        isLoading={isPending}
        className={cn('inline-flex items-center gap-1.5', compact && 'min-h-9')}
        aria-label="Shift to IPD"
      >
        {isPending ? null : <BedIcon className="size-4 text-brand-700" />}
        {compact ? 'IPD' : 'Shift to IPD'}
      </Button>

      {/* Doctor's Admission Advice Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-xs">
          <div
            className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-ink-950/10 dark:bg-ink-900"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shift-modal-title"
          >
            {/* Header */}
            <div className="flex items-start justify-between border-b border-ink-100 pb-4 dark:border-ink-800">
              <div className="flex items-center gap-3">
                <div className="flex size-10 items-center justify-center rounded-xl bg-brand-50 text-brand-700 dark:bg-brand-950/50 dark:text-brand-300">
                  <BedIcon className="size-5" />
                </div>
                <div>
                  <h3 id="shift-modal-title" className="text-base font-bold text-ink-900 dark:text-ink-50">
                    Shift to IPD · Admission Advice
                  </h3>
                  <p className="text-xs text-ink-500">
                    {patientName ? `Patient: ${patientName} · ` : ''}Advise reception & nursing team
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(false)}
                className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600 dark:hover:bg-ink-800"
                aria-label="Close"
              >
                <XIcon className="size-5" />
              </button>
            </div>

            {/* Form Fields */}
            <div className="mt-4 space-y-4">
              {/* Urgency */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-600 dark:text-ink-300">
                  Clinical Urgency
                </label>
                <div className="mt-1.5 grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() => setUrgency('emergency')}
                    className={cn(
                      'flex flex-col items-center justify-center rounded-xl border p-2.5 text-xs font-semibold transition-all',
                      urgency === 'emergency'
                        ? 'border-rose-500 bg-rose-50 text-rose-800 ring-2 ring-rose-500/20 dark:bg-rose-950/40 dark:text-rose-200'
                        : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300',
                    )}
                  >
                    <span className="flex items-center gap-1 text-rose-600 dark:text-rose-400">
                      <AlertCircleIcon className="size-3.5" />
                      Emergency
                    </span>
                    <span className="text-[10px] font-normal opacity-75">Immediate bed</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setUrgency('same_day')}
                    className={cn(
                      'flex flex-col items-center justify-center rounded-xl border p-2.5 text-xs font-semibold transition-all',
                      urgency === 'same_day'
                        ? 'border-amber-500 bg-amber-50 text-amber-800 ring-2 ring-amber-500/20 dark:bg-amber-950/40 dark:text-amber-200'
                        : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300',
                    )}
                  >
                    <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400">
                      <ClockIcon className="size-3.5" />
                      Same-Day
                    </span>
                    <span className="text-[10px] font-normal opacity-75">Within hours</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setUrgency('planned')}
                    className={cn(
                      'flex flex-col items-center justify-center rounded-xl border p-2.5 text-xs font-semibold transition-all',
                      urgency === 'planned'
                        ? 'border-blue-500 bg-blue-50 text-blue-800 ring-2 ring-blue-500/20 dark:bg-blue-950/40 dark:text-blue-200'
                        : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300',
                    )}
                  >
                    <span className="text-blue-600 dark:text-blue-400">Planned</span>
                    <span className="text-[10px] font-normal opacity-75">Elective</span>
                  </button>
                </div>
              </div>

              {/* Advised Ward Type */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-ink-600 dark:text-ink-300">
                  Advised Ward Type
                </label>
                <div className="mt-1.5 grid grid-cols-4 gap-2">
                  {(['general', 'special', 'hdu', 'icu'] as const).map((ward) => (
                    <button
                      key={ward}
                      type="button"
                      onClick={() => setAdvisedWardKind(ward)}
                      className={cn(
                        'rounded-lg border px-2.5 py-1.5 text-xs font-medium capitalize transition-colors',
                        advisedWardKind === ward
                          ? 'border-brand-600 bg-brand-50 text-brand-900 ring-2 ring-brand-500/20 dark:bg-brand-950/40 dark:text-brand-200'
                          : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-300',
                      )}
                    >
                      {ward === 'general'
                        ? 'General'
                        : ward === 'special'
                          ? 'Special'
                          : ward.toUpperCase()}
                    </button>
                  ))}
                </div>
              </div>

              {/* Provisional Diagnosis */}
              <div>
                <label
                  htmlFor="shift-reason"
                  className="block text-xs font-semibold uppercase tracking-wider text-ink-600 dark:text-ink-300"
                >
                  Provisional Diagnosis / Reason
                </label>
                <input
                  id="shift-reason"
                  type="text"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. Acute Gastroenteritis, severe dehydration"
                  className="mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100"
                />
              </div>

              {/* Stay & Reception Note row */}
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label
                    htmlFor="shift-stay"
                    className="block text-xs font-semibold uppercase tracking-wider text-ink-600 dark:text-ink-300"
                  >
                    Est. Stay (Days)
                  </label>
                  <input
                    id="shift-stay"
                    type="number"
                    min="1"
                    max="90"
                    value={estimatedStayDays}
                    onChange={(e) =>
                      setEstimatedStayDays(e.target.value === '' ? '' : parseInt(e.target.value, 10))
                    }
                    className="mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100"
                  />
                </div>

                <div className="col-span-2">
                  <label
                    htmlFor="shift-notes"
                    className="block text-xs font-semibold uppercase tracking-wider text-ink-600 dark:text-ink-300"
                  >
                    Note for Reception / Desk
                  </label>
                  <input
                    id="shift-notes"
                    type="text"
                    value={receptionNotes}
                    onChange={(e) => setReceptionNotes(e.target.value)}
                    placeholder="e.g. Keep O2 ready, NBM"
                    className="mt-1 w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 dark:border-ink-700 dark:bg-ink-800 dark:text-ink-100"
                  />
                </div>
              </div>
            </div>

            {/* Actions */}
            <div className="mt-6 flex items-center justify-end gap-2 border-t border-ink-100 pt-4 dark:border-ink-800">
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={() => setIsModalOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="md"
                onClick={handleConfirmShift}
                isLoading={isPending}
                className="gap-2"
              >
                <BedIcon className="size-4" />
                Confirm Shift to IPD
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** Shown in place of the button once the patient is on the IPD side. */
export function IpdBadge({ label = 'awaiting bed' }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-brand-50 px-2.5 py-1 text-xs font-semibold text-brand-800 ring-1 ring-inset ring-brand-200">
      <BedIcon className="size-3.5" />
      IPD · {label}
    </span>
  );
}
