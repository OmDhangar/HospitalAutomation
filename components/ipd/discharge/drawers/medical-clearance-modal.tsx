'use client';

import React, { useState } from 'react';
import { CheckIcon, XIcon } from '@/components/icons';

export interface MedicalClearanceModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  patientName?: string;
  doctorName?: string;
  initialDischargeType?: 'regular' | 'lama' | 'dama' | 'transfer' | 'absconded' | 'death';
  initialNotes?: string | null;
  isReady?: boolean;
  onSave: (data: {
    dischargeType: 'regular' | 'lama' | 'dama' | 'transfer' | 'absconded' | 'death';
    clinicalStabilityNotes: string;
    ready: boolean;
  }) => Promise<void>;
}

export function MedicalClearanceModal({
  isOpen,
  onClose,
  admissionId,
  patientName,
  doctorName,
  initialDischargeType = 'regular',
  initialNotes = '',
  isReady = false,
  onSave,
}: MedicalClearanceModalProps) {
  const [dischargeType, setDischargeType] = useState(initialDischargeType);
  const [notes, setNotes] = useState(initialNotes || '');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Clinical stability checklist
  const [vitalsStable, setVitalsStable] = useState(true);
  const [afebrile24h, setAfebrile24h] = useState(true);
  const [woundInspected, setWoundInspected] = useState(true);

  if (!isOpen) return null;

  const handleSubmit = async (markReady: boolean) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await onSave({
        dischargeType,
        clinicalStabilityNotes: notes,
        ready: markReady,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to update medical clearance');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto bg-ink-950/40 backdrop-blur-xs flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="bg-surface rounded-xl border border-ink-200 shadow-xl max-w-lg w-full overflow-hidden text-ink-900 animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-4 border-b border-ink-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-ink-950">Medical Clearance &amp; Stability</h2>
            <p className="text-2xs text-ink-500">
              Consultant certification for {patientName ?? 'Patient'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded text-ink-400 hover:text-ink-700 hover:bg-ink-100"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs">
          {error && (
            <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-800 rounded-md">
              {error}
            </div>
          )}

          {doctorName && (
            <div className="p-2.5 bg-brand-50/60 border border-brand-200/80 rounded-lg flex items-center justify-between text-2xs">
              <span className="text-ink-600">Attending Consultant:</span>
              <span className="font-bold text-brand-900">{doctorName}</span>
            </div>
          )}

          {/* Discharge Type */}
          <div>
            <label className="block text-2xs font-bold text-ink-700 mb-1">
              Discharge Classification:
            </label>
            <select
              value={dischargeType}
              onChange={(e) => setDischargeType(e.target.value as any)}
              className="w-full px-3 py-2 text-xs rounded-lg border border-ink-300 bg-surface focus:outline-none focus:ring-1 focus:ring-primary font-medium"
            >
              <option value="regular">Regular Discharge (Planned Recovery)</option>
              <option value="dama">DAMA (Discharge Against Medical Advice)</option>
              <option value="lama">LAMA (Left Against Medical Advice)</option>
              <option value="transfer">Transfer to Higher Medical Center</option>
              <option value="absconded">Absconded / Left Ward Unannounced</option>
              <option value="death">Expired (Clinical Decease)</option>
            </select>
          </div>

          {/* Stability Checklist */}
          <div className="space-y-2 p-3 bg-ink-50 rounded-lg border border-ink-200">
            <span className="text-2xs font-bold text-ink-700 uppercase tracking-wider">
              Clinical Stability Criteria
            </span>
            <div className="space-y-1.5 text-2xs">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={vitalsStable}
                  onChange={(e) => setVitalsStable(e.target.checked)}
                  className="size-3.5 rounded border-ink-300 text-primary"
                />
                <span>Hemodynamically stable; discharge vitals verified</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={afebrile24h}
                  onChange={(e) => setAfebrile24h(e.target.checked)}
                  className="size-3.5 rounded border-ink-300 text-primary"
                />
                <span>Afebrile for &gt;24 hours (or baseline stable)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={woundInspected}
                  onChange={(e) => setWoundInspected(e.target.checked)}
                  className="size-3.5 rounded border-ink-300 text-primary"
                />
                <span>Surgical wound / clinical site clean; dressings secure</span>
              </label>
            </div>
          </div>

          {/* Clinical Notes */}
          <div>
            <label className="block text-2xs font-semibold text-ink-700 mb-1">
              Clinical Discharge Notes &amp; Advice:
            </label>
            <textarea
              rows={3}
              placeholder="e.g. Patient stable post-appendectomy, ambulating well, sutures intact. Tolerating oral diet."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full p-2.5 text-xs rounded-lg border border-ink-300 focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-ink-50/70 border-t border-ink-200 flex items-center justify-between">
          {isReady ? (
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmit(false)}
              className="px-3 py-1.5 text-xs font-semibold rounded border border-rose-300 text-rose-700 bg-rose-50 hover:bg-rose-100"
            >
              {isSubmitting ? 'Updating...' : 'Revoke Medical Fit'}
            </button>
          ) : (
            <span className="text-2xs text-ink-500">Certify patient is clinically fit to leave</span>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-xs font-semibold text-ink-600 hover:text-ink-900"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => handleSubmit(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded bg-emerald-600 text-white hover:bg-emerald-700 shadow-2xs"
            >
              <CheckIcon className="size-4" />
              <span>{isSubmitting ? 'Saving...' : 'Certify Fit to Discharge'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
