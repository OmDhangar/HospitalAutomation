'use client';

import React, { useState } from 'react';
import { recordClinicalNoteAction } from '@/app/(app)/ipd/actions';

export interface AddClinicalNoteModalProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function AddClinicalNoteModal({
  admissionId,
  isOpen,
  onClose,
  onSuccess,
}: AddClinicalNoteModalProps) {
  const [noteType, setNoteType] = useState<'SOAP' | 'NURSING' | 'HANDOVER'>('SOAP');
  const [soapS, setSoapS] = useState('');
  const [soapO, setSoapO] = useState('');
  const [soapA, setSoapA] = useState('');
  const [soapP, setSoapP] = useState('');
  const [body, setBody] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setError(null);
    try {
      await recordClinicalNoteAction({
        admissionId,
        noteType,
        soapS: noteType === 'SOAP' ? soapS.trim() : null,
        soapO: noteType === 'SOAP' ? soapO.trim() : null,
        soapA: noteType === 'SOAP' ? soapA.trim() : null,
        soapP: noteType === 'SOAP' ? soapP.trim() : null,
        body: noteType !== 'SOAP' ? body.trim() : null,
      });
      if (onSuccess) onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to record clinical note.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-2xs">
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-5 shadow-xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 className="text-sm font-bold text-ink-950">Add Clinical Progress Note</h3>
            <p className="text-xs text-ink-500">Record doctor round evaluation or nursing handover</p>
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
          {/* Note Type Selector */}
          <div>
            <label className="block font-semibold text-ink-700 mb-1.5">Note Type</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setNoteType('SOAP')}
                className={`rounded-lg border px-3 py-2 text-center text-xs font-bold transition cursor-pointer ${
                  noteType === 'SOAP'
                    ? 'border-brand-600 bg-brand-50 text-brand-900'
                    : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                }`}
              >
                Doctor SOAP Note
              </button>
              <button
                type="button"
                onClick={() => setNoteType('NURSING')}
                className={`rounded-lg border px-3 py-2 text-center text-xs font-bold transition cursor-pointer ${
                  noteType === 'NURSING'
                    ? 'border-brand-600 bg-brand-50 text-brand-900'
                    : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                }`}
              >
                Nursing Progress
              </button>
              <button
                type="button"
                onClick={() => setNoteType('HANDOVER')}
                className={`rounded-lg border px-3 py-2 text-center text-xs font-bold transition cursor-pointer ${
                  noteType === 'HANDOVER'
                    ? 'border-brand-600 bg-brand-50 text-brand-900'
                    : 'border-ink-200 hover:bg-ink-50 text-ink-700'
                }`}
              >
                Shift Handover
              </button>
            </div>
          </div>

          {/* Form Fields: SOAP */}
          {noteType === 'SOAP' ? (
            <div className="space-y-2.5">
              <div>
                <label className="block font-semibold text-ink-700 mb-1">
                  S - Subjective (Patient symptoms, complaints)
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Patient feels better, mild headache persisting, slept well..."
                  value={soapS}
                  onChange={(e) => setSoapS(e.target.value)}
                  className="w-full rounded-lg border border-ink-300 p-2 text-xs focus:border-brand-500 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-ink-700 mb-1">
                  O - Objective (Physical exam, vitals, findings)
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Afebrile, BP 120/80, chest clear bilaterally, abdomen soft..."
                  value={soapO}
                  onChange={(e) => setSoapO(e.target.value)}
                  className="w-full rounded-lg border border-ink-300 p-2 text-xs focus:border-brand-500 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-ink-700 mb-1">
                  A - Assessment (Working diagnosis, trajectory)
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Viral pyrexia responding to antipyretics, hydration restored..."
                  value={soapA}
                  onChange={(e) => setSoapA(e.target.value)}
                  className="w-full rounded-lg border border-ink-300 p-2 text-xs focus:border-brand-500 focus:outline-hidden"
                />
              </div>

              <div>
                <label className="block font-semibold text-ink-700 mb-1">
                  P - Plan (Orders, next steps, discharge outlook)
                </label>
                <textarea
                  rows={2}
                  placeholder="e.g. Discontinue IV line tomorrow, resume regular diet, check CBC..."
                  value={soapP}
                  onChange={(e) => setSoapP(e.target.value)}
                  className="w-full rounded-lg border border-ink-300 p-2 text-xs focus:border-brand-500 focus:outline-hidden"
                />
              </div>
            </div>
          ) : (
            <div>
              <label className="block font-semibold text-ink-700 mb-1">
                Clinical Observation / Handover Details
              </label>
              <textarea
                rows={6}
                required
                placeholder="Enter nursing observations, medications administered, intake details, IV cannula status, or shift handover notes..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="w-full rounded-lg border border-ink-300 p-2.5 text-xs focus:border-brand-500 focus:outline-hidden"
              />
            </div>
          )}

          {/* Actions */}
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
              disabled={isSubmitting}
              className="rounded-lg bg-brand-700 px-4 py-1.5 text-xs font-bold text-white shadow-xs hover:bg-brand-800 disabled:opacity-50 cursor-pointer"
            >
              {isSubmitting ? 'Saving Note…' : 'Save Clinical Note'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
