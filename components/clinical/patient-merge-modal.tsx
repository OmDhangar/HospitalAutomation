'use client';

import React, { useState, useTransition } from 'react';
import { Button, Input, cn } from '@/components/ui';
import { useToast } from '@/components/toast';
import {
  checkMergeCriticalityDynamic,
  mergePatientsDynamic,
} from '@/app/(app)/dashboard/patient-identity-actions';
import type { PatientDuplicateMatch } from '@/lib/services/patient-merge';

export type PatientMergeModalProps = {
  isOpen: boolean;
  onClose: () => void;
  sourcePatient?: PatientDuplicateMatch['patient'] | null;
  targetPatient?: PatientDuplicateMatch['patient'] | null;
  onMergeSuccess?: (survivorId: string) => void;
};

export function PatientMergeModal({
  isOpen,
  onClose,
  sourcePatient,
  targetPatient,
  onMergeSuccess,
}: PatientMergeModalProps) {
  const toast = useToast();
  const [justification, setJustification] = useState('');
  const [isCritical, setIsCritical] = useState(false);
  const [criticalReasons, setCriticalReasons] = useState<string[]>([]);
  const [isChecking, startCheck] = useTransition();
  const [isMerging, startMerge] = useTransition();

  React.useEffect(() => {
    if (sourcePatient && targetPatient && sourcePatient.id !== targetPatient.id) {
      startCheck(async () => {
        const res = await checkMergeCriticalityDynamic({
          fromPatientId: sourcePatient.id,
          toPatientId: targetPatient.id,
        });
        if (res.ok) {
          setIsCritical(res.isCritical);
          setCriticalReasons(res.reasons);
        }
      });
    }
  }, [sourcePatient, targetPatient]);

  if (!isOpen) return null;

  const handleMerge = () => {
    if (!sourcePatient || !targetPatient) {
      toast.error('Select both source and target patients');
      return;
    }

    if (isCritical && justification.trim().length < 10) {
      toast.error('Clinical justification required', 'Please provide at least 10 characters explaining this critical merge.');
      return;
    }

    startMerge(async () => {
      const res = await mergePatientsDynamic({
        fromPatientId: sourcePatient.id,
        toPatientId: targetPatient.id,
        justification: justification.trim() || undefined,
      });

      if (res.ok) {
        toast.success(
          'Patients merged successfully',
          `${sourcePatient.name} has been merged into master record ${targetPatient.name} (${targetPatient.mrn || 'Survivor'}).`,
        );
        onMergeSuccess?.(res.survivorId);
        onClose();
      } else {
        toast.error('Merge failed', res.error);
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4"
    >
      <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl ring-1 ring-ink-200 space-y-4">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 className="text-base font-bold text-ink-950">Merge Duplicate Patient Records</h3>
            <p className="text-xs text-ink-500">Combine duplicate profiles into a single master clinical record.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-ink-700"
          >
            ✕
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
            <span className="font-bold text-rose-900 uppercase tracking-wider text-2xs block mb-1">
              Source (Duplicate)
            </span>
            {sourcePatient ? (
              <div>
                <p className="font-semibold text-ink-900">{sourcePatient.name}</p>
                <p className="font-mono text-ink-600">{sourcePatient.mrn}</p>
                <p className="text-ink-500">{sourcePatient.phoneE164}</p>
              </div>
            ) : (
              <p className="text-ink-400 italic">No source selected</p>
            )}
          </div>

          <div className="rounded-xl border border-emerald-200 bg-emerald-50/60 p-3">
            <span className="font-bold text-emerald-900 uppercase tracking-wider text-2xs block mb-1">
              Target (Survivor / Master)
            </span>
            {targetPatient ? (
              <div>
                <p className="font-semibold text-ink-900">{targetPatient.name}</p>
                <p className="font-mono text-ink-600">{targetPatient.mrn}</p>
                <p className="text-ink-500">{targetPatient.phoneE164}</p>
              </div>
            ) : (
              <p className="text-ink-400 italic">No target selected</p>
            )}
          </div>
        </div>

        {isCritical ? (
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3.5 space-y-2">
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-amber-600 animate-pulse" />
              <h4 className="text-xs font-bold text-amber-950 uppercase tracking-wider">
                Critical Patient Merge Warning
              </h4>
            </div>
            <p className="text-xs text-amber-900">
              This merge involves sensitive clinical or financial conditions:
            </p>
            <ul className="list-disc list-inside text-xs font-medium text-amber-800 space-y-0.5">
              {criticalReasons.map((r) => (
                <li key={r}>{r.replace(/_/g, ' ')}</li>
              ))}
            </ul>
            <p className="text-2xs text-amber-700 italic">
              Hospital administration will receive an audit alert for review.
            </p>

            <label className="block pt-1">
              <span className="text-xs font-semibold text-ink-800 block mb-1">
                Clinical Justification (Required) <span className="text-red-500">*</span>
              </span>
              <textarea
                value={justification}
                onChange={(e) => setJustification(e.target.value)}
                placeholder="Explain the clinical/administrative basis for merging these records..."
                className="w-full rounded-lg border-0 bg-white p-2 text-xs text-ink-900 ring-1 ring-inset ring-ink-300 placeholder:text-ink-400 focus:ring-2 focus:ring-brand-600"
                rows={2}
              />
            </label>
          </div>
        ) : null}

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-ink-100">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isMerging}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleMerge}
            isLoading={isMerging || isChecking}
            disabled={!sourcePatient || !targetPatient}
          >
            Confirm &amp; Execute Merge
          </Button>
        </div>
      </div>
    </div>
  );
}
