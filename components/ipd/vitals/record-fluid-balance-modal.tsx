'use client';

import React, { useState } from 'react';
import { recordIntakeOutputAction } from '@/app/(app)/ipd/actions';

export interface RecordFluidBalanceModalProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function RecordFluidBalanceModal({
  admissionId,
  isOpen,
  onClose,
  onSuccess,
}: RecordFluidBalanceModalProps) {
  const [kind, setKind] = useState<'ORAL' | 'IV' | 'URINE' | 'DRAIN' | 'RT_ASPIRATE'>('ORAL');
  const [ml, setMl] = useState('');
  const [notes, setNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseInt(ml, 10);
    if (isNaN(amount) || amount <= 0) {
      setError('Please enter a valid volume in ml.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await recordIntakeOutputAction({
        admissionId,
        kind,
        ml: amount,
        notes: notes.trim() || null,
      });
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to record fluid balance.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const isIntake = kind === 'ORAL' || kind === 'IV';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-300 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink-950">Record Fluid Intake / Output</h3>
            <p className="text-xs text-ink-500">Track 24-hour hydration, IV infusions &amp; drainage</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            ✕
          </button>
        </div>

        {error && (
          <div className="mt-3 rounded-lg bg-rose-50 border border-rose-200 p-2 text-xs font-semibold text-rose-800">
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} className="mt-4 space-y-3.5 text-xs">
          {/* Intake vs Output Category Selection */}
          <div>
            <label className="block font-semibold text-ink-700 mb-1.5">
              Fluid Type &amp; Category
            </label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-800">
                  Intake (+)
                </span>
                <button
                  type="button"
                  onClick={() => setKind('ORAL')}
                  className={`w-full rounded-lg border p-2 text-left transition cursor-pointer ${
                    kind === 'ORAL'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-950 font-bold'
                      : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                  }`}
                >
                  Oral Fluids (Water/Soup)
                </button>
                <button
                  type="button"
                  onClick={() => setKind('IV')}
                  className={`w-full rounded-lg border p-2 text-left transition cursor-pointer ${
                    kind === 'IV'
                      ? 'border-emerald-600 bg-emerald-50 text-emerald-950 font-bold'
                      : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                  }`}
                >
                  IV Infusion (Bottle/Bag)
                </button>
              </div>

              <div className="space-y-1">
                <span className="text-[10px] font-bold uppercase tracking-wider text-rose-800">
                  Output (-)
                </span>
                <button
                  type="button"
                  onClick={() => setKind('URINE')}
                  className={`w-full rounded-lg border p-2 text-left transition cursor-pointer ${
                    kind === 'URINE'
                      ? 'border-rose-600 bg-rose-50 text-rose-950 font-bold'
                      : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                  }`}
                >
                  Urine Output
                </button>
                <button
                  type="button"
                  onClick={() => setKind('DRAIN')}
                  className={`w-full rounded-lg border p-2 text-left transition cursor-pointer ${
                    kind === 'DRAIN'
                      ? 'border-rose-600 bg-rose-50 text-rose-950 font-bold'
                      : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                  }`}
                >
                  Surgical Drain
                </button>
                <button
                  type="button"
                  onClick={() => setKind('RT_ASPIRATE')}
                  className={`w-full rounded-lg border p-2 text-left transition cursor-pointer ${
                    kind === 'RT_ASPIRATE'
                      ? 'border-rose-600 bg-rose-50 text-rose-950 font-bold'
                      : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                  }`}
                >
                  Ryle&apos;s Tube Aspirate
                </button>
              </div>
            </div>
          </div>

          {/* Volume in ml */}
          <div>
            <label className="block font-semibold text-ink-700 mb-1">
              Volume (ml) <span className="text-rose-500">*</span>
            </label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                required
                min="1"
                step="10"
                placeholder="e.g. 500"
                value={ml}
                onChange={(e) => setMl(e.target.value)}
                className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
              />
              <span className="font-mono text-xs font-bold text-ink-600 shrink-0">ml</span>
            </div>
          </div>

          {/* Quick presets */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[10px] text-ink-500 font-semibold">Quick:</span>
            {[100, 250, 500, 1000].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setMl(String(preset))}
                className="rounded border border-ink-200 bg-ink-50 px-2 py-0.5 text-[10px] font-mono hover:bg-ink-100 cursor-pointer"
              >
                {preset} ml
              </button>
            ))}
          </div>

          {/* Notes */}
          <div>
            <label className="block font-semibold text-ink-700 mb-1">
              Clinical Notes / Details (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g. Clear urine, Normal Saline 0.9%, etc."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-ink-300 px-3 py-2 text-xs focus:border-brand-500 focus:outline-hidden"
            />
          </div>

          {/* Action indicator */}
          <div
            className={`rounded-lg p-2 font-mono text-xs font-bold text-center ${
              isIntake
                ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                : 'bg-rose-50 text-rose-800 border border-rose-200'
            }`}
          >
            {isIntake ? '+ INTAKE' : '- OUTPUT'}: {ml ? `${ml} ml` : '—'}
          </div>

          {/* Buttons */}
          <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ink-300 px-3.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || !ml}
              className="rounded-lg bg-brand-700 px-4 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-brand-800 disabled:opacity-50"
            >
              {isSubmitting ? 'Recording…' : 'Save Fluid Record'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
