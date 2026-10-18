'use client';

import React, { useState } from 'react';
import type { TestChip } from '@/lib/services/doctor-ipd';
import { orderTestsAction } from '@/app/(app)/ipd/actions';

export interface OrderInvestigationModalProps {
  admissionId: string;
  isOpen: boolean;
  testChips: TestChip[];
  onClose: () => void;
  onSuccess?: () => void;
}

export function OrderInvestigationModal({
  admissionId,
  isOpen,
  testChips,
  onClose,
  onSuccess,
}: OrderInvestigationModalProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const toggleChip = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedIds.length === 0) {
      setError('Please select at least one investigation to order.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('admissionId', admissionId);
      formData.append('formKey', crypto.randomUUID());
      formData.append('back', `/ipd/patients/${admissionId}/investigations`);
      for (const id of selectedIds) {
        formData.append('test', id);
      }
      await orderTestsAction(formData);
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to order investigations.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-lg rounded-2xl border border-slate-300 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink-950">Order Laboratory &amp; Imaging Tests</h3>
            <p className="text-xs text-ink-500">Select diagnostics to schedule for sample collection</p>
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

        <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-ink-700 mb-2">
              Available Test Catalog ({testChips.length} items)
            </label>

            {testChips.length === 0 ? (
              <p className="text-xs text-ink-500 italic p-3 rounded-lg bg-ink-50">
                No active diagnostic tests configured in hospital charge catalogue.
              </p>
            ) : (
              <div className="grid grid-cols-2 gap-2 max-h-60 overflow-y-auto p-1">
                {testChips.map((chip) => {
                  const isChecked = selectedIds.includes(chip.id);
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      onClick={() => toggleChip(chip.id)}
                      className={`flex items-center gap-2 rounded-lg border p-2.5 text-left transition cursor-pointer ${
                        isChecked
                          ? 'border-brand-600 bg-brand-50 text-brand-950 font-bold'
                          : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => {}} // Handled by button onClick
                        className="rounded border-ink-300 text-brand-600"
                      />
                      <span className="truncate text-xs">{chip.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between rounded-lg bg-ink-50 p-2.5 border border-ink-200">
            <span className="text-xs text-ink-600">Selected for order:</span>
            <span className="font-mono text-xs font-bold text-brand-900">
              {selectedIds.length} {selectedIds.length === 1 ? 'Test' : 'Tests'}
            </span>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-ink-100">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-ink-300 px-3.5 py-1.5 text-xs font-semibold text-ink-700 hover:bg-ink-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting || selectedIds.length === 0}
              className="rounded-lg bg-brand-700 px-4 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-brand-800 disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? 'Ordering…' : 'Submit Test Orders'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
