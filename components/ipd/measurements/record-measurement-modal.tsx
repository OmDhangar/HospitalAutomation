'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { recordPatientMeasurementAction } from '@/app/(app)/ipd/actions';
import { calculateBmi, getBmiCategory } from '@/lib/domain/patient-measurements';
import { Button } from '@/components/ui';

export interface RecordMeasurementModalProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  currentWeightKg?: number | null;
  currentHeightCm?: number | null;
  patientName?: string;
  onSuccess?: () => void;
}

export function RecordMeasurementModal({
  admissionId,
  isOpen,
  onClose,
  currentWeightKg,
  currentHeightCm,
  patientName = 'Patient',
  onSuccess,
}: RecordMeasurementModalProps) {
  let router: { refresh: () => void } | null = null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }

  const [isPending, startTransition] = useTransition();
  const [weightKg, setWeightKg] = useState<string>(currentWeightKg != null ? String(currentWeightKg) : '');
  const [heightCm, setHeightCm] = useState<string>(currentHeightCm != null ? String(currentHeightCm) : '');
  const [notes, setNotes] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  const numWeight = parseFloat(weightKg);
  const numHeight = parseFloat(heightCm);
  const liveBmi = calculateBmi(
    !isNaN(numWeight) && numWeight > 0 ? numWeight : null,
    !isNaN(numHeight) && numHeight > 0 ? numHeight : null,
  );

  const bmiCategory = liveBmi ? getBmiCategory(liveBmi) : null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);

    const validWeight = !isNaN(numWeight) && numWeight > 0 ? numWeight : undefined;
    const validHeight = !isNaN(numHeight) && numHeight > 0 ? numHeight : undefined;

    if (!validWeight && !validHeight) {
      setErrorMsg('Please enter at least a valid weight or height.');
      return;
    }

    startTransition(async () => {
      try {
        await recordPatientMeasurementAction({
          admissionId,
          weightKg: validWeight,
          heightCm: validHeight,
          notes: notes.trim() || undefined,
        });

        if (onSuccess) onSuccess();
        onClose();
        router?.refresh();
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to record patient measurements.');
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="record-measurement-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/60 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[90vh] w-full max-w-md flex-col rounded-2xl border border-ink-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-ink-100 px-5 py-4 bg-ink-50/50">
          <div>
            <h3 id="record-measurement-title" className="text-sm font-bold text-ink-950">
              Record Patient Measurements
            </h3>
            <p className="text-xs text-ink-500">
              {patientName} · Required for drug dosing calculations
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isPending}
            className="rounded-lg p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-600 disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
          {errorMsg && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-2.5 font-medium text-rose-900">
              ⚠️ {errorMsg}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="weight-input" className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
                Weight (kg) *
              </label>
              <input
                id="weight-input"
                type="number"
                step="0.1"
                min="0.5"
                max="350"
                value={weightKg}
                onChange={(e) => setWeightKg(e.target.value)}
                placeholder="e.g. 68.5"
                className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-950 font-semibold focus:border-brand-500 focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="height-input" className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
                Height (cm)
              </label>
              <input
                id="height-input"
                type="number"
                step="0.5"
                min="20"
                max="250"
                value={heightCm}
                onChange={(e) => setHeightCm(e.target.value)}
                placeholder="e.g. 172"
                className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-sm text-ink-950 font-semibold focus:border-brand-500 focus:outline-none"
              />
            </div>
          </div>

          {/* Live BMI Preview Card */}
          <div className="rounded-xl border border-ink-200 bg-slate-50/70 p-3">
            <div className="flex items-center justify-between">
              <span className="text-2xs font-bold text-ink-600 uppercase tracking-wide">
                Calculated BMI
              </span>
              {liveBmi ? (
                <span className={`px-2 py-0.5 rounded text-xs font-bold border ${bmiCategory?.color}`}>
                  {bmiCategory?.label}
                </span>
              ) : (
                <span className="text-2xs text-ink-400 italic">Enter weight &amp; height</span>
              )}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl font-black text-ink-900">
                {liveBmi != null ? liveBmi : '--.-'}
              </span>
              <span className="text-2xs text-ink-500 font-medium">kg/m²</span>
            </div>
          </div>

          <div>
            <label htmlFor="measurement-notes" className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
              Method / Notes
            </label>
            <input
              id="measurement-notes"
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Standing scale, bed scale, wheel-chair tare"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:border-brand-500 focus:outline-none"
            />
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-ink-100">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              isLoading={isPending}
              className="bg-brand-600 font-bold hover:bg-brand-700"
            >
              Save Measurement
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
