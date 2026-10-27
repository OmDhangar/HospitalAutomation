'use client';

import React, { useState } from 'react';
import { StatusBadge } from '@/components/ipd/status-badge';
import { CheckIcon } from '@/components/icons';

export interface NursingClearanceCardProps {
  isCleared: boolean;
  nursingClearedAt?: string | Date | null;
  ivCannulaRemoved?: boolean;
  foleyCatheterRemoved?: boolean;
  drainsRemoved?: boolean;
  woundDressingDone?: boolean;
  belongingsAndReportsHandedOver?: boolean;
  dischargeVitalsTaken?: boolean;
  nursingHandoverNotes?: string | null;
  onUpdate: (data: {
    ivCannulaRemoved: boolean;
    foleyCatheterRemoved: boolean;
    drainsRemoved: boolean;
    woundDressingDone: boolean;
    belongingsAndReportsHandedOver: boolean;
    dischargeVitalsTaken: boolean;
    nursingHandoverNotes?: string;
    cleared: boolean;
  }) => Promise<void>;
}

export function NursingClearanceCard({
  isCleared,
  nursingClearedAt,
  ivCannulaRemoved = false,
  foleyCatheterRemoved = false,
  drainsRemoved = false,
  woundDressingDone = false,
  belongingsAndReportsHandedOver = false,
  dischargeVitalsTaken = false,
  nursingHandoverNotes = '',
  onUpdate,
}: NursingClearanceCardProps) {
  const [cannula, setCannula] = useState(ivCannulaRemoved);
  const [catheter, setCatheter] = useState(foleyCatheterRemoved);
  const [dressing, setDressing] = useState(woundDressingDone);
  const [belongings, setBelongings] = useState(belongingsAndReportsHandedOver);
  const [vitals, setVitals] = useState(dischargeVitalsTaken);
  const [notes, setNotes] = useState(nursingHandoverNotes || '');
  const [isUpdating, setIsUpdating] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);

  const allMandatoryChecked = cannula && belongings && vitals;

  const handleSave = async (markCleared: boolean) => {
    setIsUpdating(true);
    setFeedback(null);
    try {
      await onUpdate({
        ivCannulaRemoved: cannula,
        foleyCatheterRemoved: catheter,
        drainsRemoved,
        woundDressingDone: dressing,
        belongingsAndReportsHandedOver: belongings,
        dischargeVitalsTaken: vitals,
        nursingHandoverNotes: notes,
        cleared: markCleared,
      });
      setFeedback(markCleared ? 'Nursing handover cleared.' : 'Checklist updated.');
    } catch (err: any) {
      setFeedback(err?.message || 'Failed to update nursing handover');
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <div className="bg-surface p-4 rounded-xl border border-ink-200/80 shadow-2xs space-y-3.5 flex flex-col justify-between">
      <div className="space-y-2.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="size-5 rounded-full bg-primary/10 text-primary font-bold text-2xs flex items-center justify-center">
              3
            </span>
            <h3 className="text-xs font-bold text-ink-900">Nursing &amp; Bedside Handover</h3>
          </div>
          <StatusBadge
            status={isCleared ? 'Handover Complete' : cannula ? 'Checklist In-Progress' : 'Lines Active'}
            variant={isCleared ? 'green' : cannula ? 'amber' : 'red'}
          />
        </div>

        <p className="text-2xs text-ink-500">
          Invasive cannula removal, catheter discontinuation, wound dressing, and belongings handover.
        </p>

        {feedback && (
          <div className="p-2 bg-emerald-50 text-emerald-800 text-2xs rounded border border-emerald-200">
            {feedback}
          </div>
        )}

        {/* Interactive Safety Checklist */}
        <div className="pt-2 border-t border-ink-100 space-y-2 text-2xs text-ink-800">
          <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-ink-50 border border-ink-100">
            <input
              type="checkbox"
              checked={cannula}
              onChange={(e) => setCannula(e.target.checked)}
              className="size-3.5 rounded border-ink-300 text-primary"
            />
            <span className={cannula ? 'font-medium text-ink-900 line-through text-ink-400' : 'font-bold text-rose-800'}>
              IV Cannula &amp; lines removed
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-ink-50 border border-ink-100">
            <input
              type="checkbox"
              checked={catheter}
              onChange={(e) => setCatheter(e.target.checked)}
              className="size-3.5 rounded border-ink-300 text-primary"
            />
            <span className={catheter ? 'text-ink-400 line-through' : 'text-ink-800'}>
              Foley Catheter &amp; surgical drains removed (or documented as retained)
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-ink-50 border border-ink-100">
            <input
              type="checkbox"
              checked={dressing}
              onChange={(e) => setDressing(e.target.checked)}
              className="size-3.5 rounded border-ink-300 text-primary"
            />
            <span>Post-discharge surgical dressing applied</span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-ink-50 border border-ink-100">
            <input
              type="checkbox"
              checked={belongings}
              onChange={(e) => setBelongings(e.target.checked)}
              className="size-3.5 rounded border-ink-300 text-primary"
            />
            <span className={belongings ? 'font-medium text-ink-900' : 'font-semibold text-amber-800'}>
              Belongings &amp; original reports handed over (X-rays, CT films, past files)
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer p-1.5 rounded hover:bg-ink-50 border border-ink-100">
            <input
              type="checkbox"
              checked={vitals}
              onChange={(e) => setVitals(e.target.checked)}
              className="size-3.5 rounded border-ink-300 text-primary"
            />
            <span>Final discharge vitals charted &amp; verified</span>
          </label>
        </div>
      </div>

      <div className="pt-2 border-t border-ink-100 flex items-center justify-between gap-2">
        <button
          type="button"
          disabled={isUpdating}
          onClick={() => handleSave(false)}
          className="px-2.5 py-1.5 text-2xs font-semibold rounded border border-ink-200 text-ink-700 bg-surface hover:bg-ink-50"
        >
          {isUpdating ? 'Saving...' : 'Save Draft'}
        </button>

        <button
          type="button"
          disabled={isUpdating || !allMandatoryChecked}
          onClick={() => handleSave(true)}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded shadow-2xs ${
            allMandatoryChecked
              ? 'bg-emerald-600 text-white hover:bg-emerald-700'
              : 'bg-ink-200 text-ink-500 cursor-not-allowed'
          }`}
        >
          <CheckIcon className="size-3.5" />
          <span>{isCleared ? 'Update Nursing Sign-off' : 'Sign off Nursing Clearance'}</span>
        </button>
      </div>
    </div>
  );
}
