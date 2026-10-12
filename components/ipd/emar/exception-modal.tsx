'use client';

import { useState, useTransition } from 'react';
import { Button, cn } from '@/components/ui';
import type { BedsideDueItem } from '@/lib/services/ipd-emar';
import { recordExceptionAction } from '@/app/(app)/ipd/actions';

export interface ExceptionModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  dueItem: BedsideDueItem | null;
  onSuccess: (administrationId: string) => void;
}

const COMMON_REASONS = [
  { outcome: 'omitted' as const, text: 'NPO for procedure / fasting' },
  { outcome: 'omitted' as const, text: 'Patient off-ward for imaging / investigation' },
  { outcome: 'omitted' as const, text: 'Medication temporarily out of stock' },
  { outcome: 'held' as const, text: 'Vital signs outside safe parameters (Low BP / Bradycardia)' },
  { outcome: 'held' as const, text: 'Patient vomiting / unable to swallow' },
  { outcome: 'refused' as const, text: 'Patient declined / refused medication' },
  { outcome: 'refused' as const, text: 'Patient sleeping, refused waking' },
];

export function ExceptionModal({
  isOpen,
  onClose,
  admissionId,
  dueItem,
  onSuccess,
}: ExceptionModalProps) {
  const [isPending, startTransition] = useTransition();
  const [outcome, setOutcome] = useState<'omitted' | 'refused' | 'held'>('omitted');
  const [selectedReason, setSelectedReason] = useState<string>('NPO for procedure / fasting');
  const [customReason, setCustomReason] = useState<string>('');
  const [clinicalNote, setClinicalNote] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen || !dueItem) return null;

  const handleConfirm = () => {
    setErrorMsg(null);
    const finalReason = customReason.trim() ? customReason.trim() : selectedReason;
    if (!finalReason || finalReason.length < 3) {
      setErrorMsg('A structured clinical reason is mandatory for non-administration.');
      return;
    }

    startTransition(async () => {
      try {
        const res = await recordExceptionAction({
          admissionId,
          orderId: dueItem.orderId,
          input: {
            clientId: crypto.randomUUID(),
            scheduledTime: dueItem.scheduledTime,
            outcome,
            nonAdminReason: finalReason,
            clinicalNote: clinicalNote.trim() || undefined,
            recordedChannel: 'ward_device',
          },
        });

        onSuccess(res.administrationId);
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to record exception');
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="exception-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 id="exception-dialog-title" className="text-base font-bold text-ink-900">
              Record Non-Administration Exception
            </h3>
            <p className="text-xs text-ink-500">
              Document clinical withhold, patient refusal, or omission reason.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded p-1 text-ink-400 hover:text-ink-600 disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {errorMsg && (
          <div className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-2.5 text-xs text-rose-900 font-medium">
            ⚠️ {errorMsg}
          </div>
        )}

        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-bold text-amber-950">{dueItem.medicineName}</span>
            <span className="font-mono text-ink-700">
              {dueItem.doseAmount} {dueItem.doseUnit}
            </span>
          </div>
        </div>

        {/* Outcome Selector */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-ink-700 mb-1.5">
            Exception Outcome Type <span className="text-rose-500">*</span>
          </label>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => setOutcome('omitted')}
              className={cn(
                'rounded-lg border p-2 text-center text-xs font-semibold transition',
                outcome === 'omitted'
                  ? 'border-amber-400 bg-amber-50 text-amber-900 shadow-xs'
                  : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
              )}
            >
              Omitted
            </button>
            <button
              type="button"
              onClick={() => setOutcome('held')}
              className={cn(
                'rounded-lg border p-2 text-center text-xs font-semibold transition',
                outcome === 'held'
                  ? 'border-violet-400 bg-violet-50 text-violet-900 shadow-xs'
                  : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
              )}
            >
              Held (Clinical)
            </button>
            <button
              type="button"
              onClick={() => setOutcome('refused')}
              className={cn(
                'rounded-lg border p-2 text-center text-xs font-semibold transition',
                outcome === 'refused'
                  ? 'border-rose-400 bg-rose-50 text-rose-900 shadow-xs'
                  : 'border-ink-200 bg-white text-ink-700 hover:bg-ink-50',
              )}
            >
              Refused
            </button>
          </div>
        </div>

        {/* Structured Preset Reasons */}
        <div className="mt-4">
          <label className="block text-xs font-semibold text-ink-700 mb-1.5">
            Select Structured Clinical Reason <span className="text-rose-500">*</span>
          </label>
          <div className="space-y-1.5 max-h-40 overflow-y-auto pr-1">
            {COMMON_REASONS.map((r, i) => (
              <label
                key={i}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border p-2 text-xs cursor-pointer transition',
                  selectedReason === r.text && !customReason
                    ? 'border-brand-400 bg-brand-50/70 text-brand-950 font-medium'
                    : 'border-ink-200 bg-white text-ink-800 hover:bg-ink-50',
                )}
              >
                <input
                  type="radio"
                  name="reason-preset"
                  checked={selectedReason === r.text && !customReason}
                  onChange={() => {
                    setSelectedReason(r.text);
                    setCustomReason('');
                    setOutcome(r.outcome);
                  }}
                  className="size-3.5 text-brand-600 focus:ring-brand-500"
                />
                <span>{r.text}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Custom Reason input */}
        <div className="mt-3">
          <label className="block text-xs font-medium text-ink-600">
            Or Specify Other Custom Reason:
          </label>
          <input
            type="text"
            placeholder="Type custom reason if not listed above..."
            value={customReason}
            onChange={(e) => setCustomReason(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        {/* Clinical Note */}
        <div className="mt-3">
          <label className="block text-xs font-medium text-ink-600">
            Additional Clinical Observations / Context:
          </label>
          <input
            type="text"
            placeholder="e.g. SBP was 82 mmHg, notified Dr. Roy"
            value={clinicalNote}
            onChange={(e) => setClinicalNote(e.target.value)}
            className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-1.5 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div className="mt-6 flex items-center justify-end gap-2 border-t border-ink-100 pt-3">
          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isPending}
          >
            Cancel
          </Button>

          <Button
            variant="primary"
            size="sm"
            onClick={handleConfirm}
            isLoading={isPending}
            className="bg-amber-600 font-bold hover:bg-amber-700 px-5 text-white"
          >
            Record Exception
          </Button>
        </div>
      </div>
    </div>
  );
}
