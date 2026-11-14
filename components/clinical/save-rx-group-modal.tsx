'use client';

import React, { useState, useEffect } from 'react';
import type { DraftLine } from '@/lib/domain/consultation';
import type { CreateRxGroupItemInput } from '@/lib/services/rx-groups';

export interface SaveRxGroupModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: DraftLine[];
  currentDiagnosis?: string;
  currentAdvice?: string;
  onSave: (data: {
    name: string;
    description?: string;
    category?: string;
    defaultDiagnosis?: string;
    defaultAdvice?: string;
    defaultFollowUpDays?: number;
    items: CreateRxGroupItemInput[];
    isPersonal: boolean;
  }) => Promise<void>;
}

export function SaveRxGroupModal({
  isOpen,
  onClose,
  items,
  currentDiagnosis = '',
  currentAdvice = '',
  onSave,
}: SaveRxGroupModalProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('general');
  const [includeDiagnosis, setIncludeDiagnosis] = useState(true);
  const [includeAdvice, setIncludeAdvice] = useState(true);
  const [isPersonal, setIsPersonal] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setName(currentDiagnosis ? `${currentDiagnosis} Protocol` : '');
      setDescription('');
      setCategory('general');
      setIncludeDiagnosis(Boolean(currentDiagnosis));
      setIncludeAdvice(Boolean(currentAdvice));
      setIsPersonal(true);
      setError(null);
    }
  }, [isOpen, currentDiagnosis, currentAdvice]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      setError('Please provide a template name (at least 2 characters).');
      return;
    }

    if (items.length === 0) {
      setError('At least one medication is required to save an Rx-Group.');
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      const mappedItems: CreateRxGroupItemInput[] = items.map((line, index) => ({
        medicineId: line.medicineId,
        medicineName: line.medicineLabel || 'Medication',
        dose: line.dose || '1 tablet',
        frequency: line.frequency || '1-0-1',
        durationDays: line.durationDays ?? null,
        instructions: line.instructions ?? null,
        sortOrder: index,
      }));

      await onSave({
        name: trimmed,
        description: description.trim() || undefined,
        category: category.trim() || 'general',
        defaultDiagnosis: includeDiagnosis && currentDiagnosis.trim() ? currentDiagnosis.trim() : undefined,
        defaultAdvice: includeAdvice && currentAdvice.trim() ? currentAdvice.trim() : undefined,
        items: mappedItems,
        isPersonal,
      });

      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to save Rx-Group.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink-950/40 backdrop-blur-xs animate-in fade-in duration-150">
      <div className="bg-white rounded-xl shadow-xl max-w-lg w-full border border-ink-200 overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-4 border-b border-ink-100 flex items-center justify-between bg-surface">
          <div className="flex items-center gap-2">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-brand-600 text-white text-xs font-bold">
              ⚡
            </span>
            <h3 className="text-sm font-bold text-ink-950">Save as Reusable Rx-Group</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-400 hover:text-ink-700 p-1 rounded-md text-base leading-none"
          >
            ✕
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4 overflow-y-auto text-xs">
          {error && (
            <div className="p-2.5 rounded-md bg-rose-50 border border-rose-200 text-rose-800 font-medium">
              {error}
            </div>
          )}

          <div>
            <label className="block font-semibold text-ink-800 mb-1">
              Template Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acute Pharyngitis Pack, URI Adult"
              className="w-full text-xs p-2 rounded-lg border border-ink-300 focus:outline-none focus:ring-2 focus:ring-brand-600"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-ink-800 mb-1">Clinical Category</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value)}
                className="w-full text-xs p-2 rounded-lg border border-ink-300 bg-white focus:outline-none focus:ring-2 focus:ring-brand-600"
              >
                <option value="general">General Medicine</option>
                <option value="respiratory">Respiratory</option>
                <option value="gastroenterology">Gastroenterology</option>
                <option value="cardiology">Cardiology</option>
                <option value="diabetology">Diabetology</option>
                <option value="pediatrics">Pediatrics</option>
                <option value="orthopedics">Orthopedics</option>
                <option value="dermatology">Dermatology</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-ink-800 mb-1">Sharing Scope</label>
              <div className="flex items-center gap-2 pt-2">
                <label className="inline-flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={isPersonal}
                    onChange={(e) => setIsPersonal(e.target.checked)}
                    className="rounded border-ink-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span className="text-ink-700">Personal (Only visible to me)</span>
                </label>
              </div>
            </div>
          </div>

          {/* Included Items Preview */}
          <div className="space-y-1.5">
            <span className="font-semibold text-ink-800">
              Medications to Bundle ({items.length})
            </span>
            <div className="max-h-36 overflow-y-auto divide-y divide-ink-100 rounded-lg border border-ink-200 bg-ink-50/50 p-2">
              {items.map((line) => (
                <div key={line.medicineId} className="py-1 flex items-center justify-between text-ink-900">
                  <span className="font-semibold">{line.medicineLabel}</span>
                  <span className="text-ink-600">
                    {line.dose || '1 tab'} · {line.frequency || '1-0-1'}
                    {line.durationDays ? ` · ${line.durationDays}d` : ''}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Optional Defaults Checklist */}
          <div className="space-y-2 border-t border-ink-100 pt-3">
            <span className="font-semibold text-ink-800 block">Bundle Defaults</span>

            {currentDiagnosis && (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeDiagnosis}
                  onChange={(e) => setIncludeDiagnosis(e.target.checked)}
                  className="rounded border-ink-300 text-brand-600 focus:ring-brand-500 mt-0.5"
                />
                <span className="text-ink-700">
                  Include Diagnosis: <strong className="text-ink-900">&ldquo;{currentDiagnosis}&rdquo;</strong>
                </span>
              </label>
            )}

            {currentAdvice && (
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={includeAdvice}
                  onChange={(e) => setIncludeAdvice(e.target.checked)}
                  className="rounded border-ink-300 text-brand-600 focus:ring-brand-500 mt-0.5"
                />
                <span className="text-ink-700">
                  Include Advice: <strong className="text-ink-900">&ldquo;{currentAdvice}&rdquo;</strong>
                </span>
              </label>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex justify-end gap-2 pt-3 border-t border-ink-100">
            <button
              type="button"
              disabled={isSubmitting}
              onClick={onClose}
              className="px-3.5 py-1.5 font-semibold rounded-lg border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-9"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-1.5 font-semibold rounded-lg bg-brand-600 text-white hover:bg-brand-700 shadow-2xs transition-colors min-h-9 disabled:opacity-50"
            >
              {isSubmitting ? 'Saving...' : 'Save Rx-Group'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
