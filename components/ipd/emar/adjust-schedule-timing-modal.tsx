'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { adjustMedicationTimingAction } from '@/app/(app)/ipd/actions';
import { isValidClockTime } from '@/lib/domain/ipd-schedule';

export interface AdjustScheduleTimingModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  orderId: string;
  medicineName: string;
  currentScheduleTimes: string[];
  onSuccess: (newTimes: string[]) => void;
}

export function AdjustScheduleTimingModal({
  isOpen,
  onClose,
  admissionId,
  orderId,
  medicineName,
  currentScheduleTimes,
  onSuccess,
}: AdjustScheduleTimingModalProps) {
  const [isPending, startTransition] = useTransition();
  const [times, setTimes] = useState<string[]>(() =>
    currentScheduleTimes.length > 0 ? [...currentScheduleTimes] : ['08:00'],
  );
  const [reasonCategory, setReasonCategory] = useState<string>('Patient sleep cycle / home routine alignment');
  const [customReason, setCustomReason] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleAddTime = () => {
    setTimes((prev) => [...prev, '12:00']);
  };

  const handleRemoveTime = (index: number) => {
    setTimes((prev) => prev.filter((_, i) => i !== index));
  };

  const handleTimeChange = (index: number, val: string) => {
    setTimes((prev) => {
      const next = [...prev];
      next[index] = val;
      return next;
    });
  };

  const handleApplyPreset = (presetTimes: string[]) => {
    setTimes([...presetTimes]);
  };

  const handleSave = () => {
    setErrorMsg(null);
    if (times.length === 0) {
      setErrorMsg('At least one schedule time slot is required.');
      return;
    }

    const invalid = times.find((t) => !isValidClockTime(t));
    if (invalid) {
      setErrorMsg(`Invalid clock time format "${invalid}". Use HH:MM in 24-hour format.`);
      return;
    }

    const finalReason =
      reasonCategory === 'Other'
        ? customReason.trim()
        : customReason.trim()
        ? `${reasonCategory}: ${customReason.trim()}`
        : reasonCategory;

    if (!finalReason || finalReason.length < 3) {
      setErrorMsg('Please specify a clinical reason for changing medication timings.');
      return;
    }

    startTransition(async () => {
      try {
        const res = await adjustMedicationTimingAction({
          admissionId,
          orderId,
          newScheduleTimes: times,
          reason: finalReason,
        });

        if (res.ok) {
          onSuccess(res.newScheduleTimes);
          onClose();
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to adjust medication timing');
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="timing-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 id="timing-modal-title" className="text-base font-bold text-ink-900">
              🕒 Adjust Medication Administration Timing
            </h3>
            <p className="text-xs text-ink-500">
              Update administration times and document why for doctor visibility.
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

        <div className="mt-3 rounded-xl border border-brand-200 bg-brand-50/50 p-3 text-xs">
          <span className="text-brand-900 font-semibold uppercase tracking-wider text-[11px] block">
            Medication Order
          </span>
          <p className="text-sm font-black text-ink-950 mt-0.5">{medicineName}</p>
          <p className="text-ink-600 mt-1">
            Current times: <span className="font-mono font-bold text-ink-800">[{currentScheduleTimes.join(', ') || 'None'}]</span>
          </p>
        </div>

        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-bold text-ink-800">
              New Administration Time Slots (24h)
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              {times.map((timeStr, idx) => (
                <div key={idx} className="flex items-center gap-1 rounded-lg border border-ink-300 bg-white p-1">
                  <input
                    type="time"
                    value={timeStr}
                    onChange={(e) => handleTimeChange(idx, e.target.value)}
                    className="font-mono text-xs text-ink-900 px-1 py-0.5 focus:outline-none"
                  />
                  {times.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveTime(idx)}
                      className="rounded px-1.5 py-0.5 text-xs text-rose-600 hover:bg-rose-50 font-bold"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              <button
                type="button"
                onClick={handleAddTime}
                className="rounded-lg border border-dashed border-ink-300 px-2.5 py-1 text-xs font-semibold text-ink-600 hover:border-ink-400 hover:text-ink-900"
              >
                + Add Slot
              </button>
            </div>
          </div>

          <div>
            <span className="text-[11px] font-semibold text-ink-500">Quick Hospital Shifts:</span>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => handleApplyPreset(['08:00'])}
                className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
              >
                Morning 8 AM
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset(['10:00'])}
                className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
              >
                Morning 10 AM (Post-Breakfast)
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset(['08:00', '20:00'])}
                className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
              >
                BD: 8 AM & 8 PM
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset(['09:00', '21:00'])}
                className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
              >
                BD: 9 AM & 9 PM
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset(['08:00', '14:00', '20:00'])}
                className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
              >
                TDS: 8 AM, 2 PM, 8 PM
              </button>
              <button
                type="button"
                onClick={() => handleApplyPreset(['21:00'])}
                className="rounded-md border border-ink-200 bg-ink-50 px-2 py-0.5 text-[11px] font-medium text-ink-700 hover:bg-ink-100"
              >
                Bedtime 9 PM
              </button>
            </div>
          </div>

          <div className="border-t border-ink-100 pt-3">
            <label className="block text-xs font-bold text-ink-800">
              Clinical Reason for Timing Change <span className="text-rose-500">*</span>
            </label>
            <p className="text-[11px] text-ink-500">
              Doctors reviewing inpatient rounds will see this explanation.
            </p>
            <select
              value={reasonCategory}
              onChange={(e) => setReasonCategory(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              <option value="Patient sleep cycle / home routine alignment">
                Patient sleep cycle / home routine alignment
              </option>
              <option value="Delayed after meal / food timing requirement">
                Delayed after meal / food timing requirement
              </option>
              <option value="Spaced from morning thyroid / interaction medication">
                Spaced from morning thyroid / interaction medication
              </option>
              <option value="Patient fasting (NPO) / procedural schedule">
                Patient fasting (NPO) / procedural schedule
              </option>
              <option value="Doctor verbal instruction to change timings">
                Doctor verbal instruction to change timings
              </option>
              <option value="Other">Other clinical reason (specify below)</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700">
              Additional Details / Clinical Notes
            </label>
            <input
              type="text"
              placeholder="e.g. Patient takes levothyroxine at 7 AM; shifted to 10 AM to prevent binding interaction"
              value={customReason}
              onChange={(e) => setCustomReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
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
            onClick={handleSave}
            isLoading={isPending}
            className="bg-brand-700 font-bold hover:bg-brand-800 px-5"
          >
            ✓ Save & Update Timing
          </Button>
        </div>
      </div>
    </div>
  );
}
