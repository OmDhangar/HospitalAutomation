'use client';

import { useState, useTransition } from 'react';
import { Button, cn } from '@/components/ui';
import type { BedsideDueItem } from '@/lib/services/ipd-emar';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';
import { recordAdministrationAction } from '@/app/(app)/ipd/actions';

export interface AdministerModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  dueItem: BedsideDueItem | null;
  patientName: string;
  bedLabel?: string;
  activeAllergies?: AllergenItem[];
  onSuccess: (administrationId: string) => void;
}

export function AdministerModal({
  isOpen,
  onClose,
  admissionId,
  dueItem,
  patientName,
  bedLabel,
  activeAllergies = [],
  onSuccess,
}: AdministerModalProps) {
  const [isPending, startTransition] = useTransition();
  const [doseGiven, setDoseGiven] = useState<string>(
    dueItem ? `${dueItem.doseAmount} ${dueItem.doseUnit}` : '',
  );
  const [routeGiven, setRouteGiven] = useState<string>(
    dueItem ? dueItem.route : 'oral',
  );
  const [siteNote, setSiteNote] = useState<string>('');
  const [actualTimeStr, setActualTimeStr] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });
  const [timingReason, setTimingReason] = useState<string>('');
  const [customTimingReason, setCustomTimingReason] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen || !dueItem) return null;

  // Cross-reference against active drug allergies
  const allergyAlert = activeAllergies.find((allergy) => {
    const medLower = dueItem.medicineName.toLowerCase();
    const substanceLower = allergy.substance.toLowerCase();
    return medLower.includes(substanceLower) || substanceLower.includes(medLower);
  });

  const formattedScheduled = new Date(dueItem.scheduledTime).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  const handleConfirm = () => {
    setErrorMsg(null);
    if (!doseGiven.trim()) {
      setErrorMsg('Please specify the dose given.');
      return;
    }

    startTransition(async () => {
      try {
        // Construct actual administration Date based on actualTimeStr
        let actualTime = new Date();
        if (actualTimeStr) {
          const [h, m] = actualTimeStr.split(':').map(Number);
          if (!isNaN(h) && !isNaN(m)) {
            actualTime = new Date();
            actualTime.setHours(h, m, 0, 0);
          }
        }

        const effectiveReason = timingReason === 'Other' ? customTimingReason.trim() : timingReason.trim();
        let finalClinicalNote = siteNote.trim();
        if (effectiveReason) {
          const timingPrefix = `[Timing deviation: Scheduled ${formattedScheduled}, Given at ${actualTimeStr} — Reason: ${effectiveReason}]`;
          finalClinicalNote = finalClinicalNote ? `${timingPrefix} ${finalClinicalNote}` : timingPrefix;
        }

        const res = await recordAdministrationAction({
          admissionId,
          orderId: dueItem.orderId,
          input: {
            clientId: crypto.randomUUID(),
            scheduledTime: dueItem.scheduledTime,
            actualTime,
            doseAmount: dueItem.doseAmount,
            doseGiven: doseGiven.trim(),
            routeGiven: routeGiven,
            clinicalNote: finalClinicalNote || undefined,
            recordedChannel: 'ward_device',
          },
        });

        onSuccess(res.administrationId);
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to record administration');
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="admin-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 id="admin-dialog-title" className="text-base font-bold text-ink-900">
              Bedside Dose Administration Verification
            </h3>
            <p className="text-xs text-ink-500">
              Confirm 5 Rights: Right Patient, Medication, Dose, Route, and Time.
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

        {/* Allergy Warning */}
        {allergyAlert && (
          <div className="mt-3 rounded-lg border-2 border-rose-500 bg-rose-50 p-3 text-xs text-rose-950 font-medium">
            <span className="font-bold text-rose-900">⚠️ ALLERGY WARNING:</span> Patient has documented reaction to{' '}
            <span className="underline font-bold">{allergyAlert.substance}</span> ({allergyAlert.severity} -{' '}
            {allergyAlert.reaction || 'no reaction noted'}). Verify safety before administering!
          </div>
        )}

        {/* Patient & Bed Verification Banner */}
        <div className="mt-3 flex items-center justify-between rounded-lg border border-ink-200 bg-ink-50/70 p-3">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
              Patient Verification
            </span>
            <p className="text-sm font-bold text-ink-900">{patientName}</p>
          </div>
          {bedLabel && (
            <span className="rounded-md border border-brand-300 bg-brand-50 px-2.5 py-1 text-xs font-bold text-brand-800">
              Bed {bedLabel}
            </span>
          )}
        </div>

        {/* Medication Details */}
        <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/40 p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-base font-bold text-emerald-950">
              {dueItem.medicineName}
            </span>
            <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-900 uppercase">
              {dueItem.route.replace('_', ' ')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-ink-500">Prescribed Dose:</span>{' '}
              <strong className="text-ink-900 font-mono">
                {dueItem.doseAmount} {dueItem.doseUnit}
              </strong>
            </div>
            <div>
              <span className="text-ink-500">Scheduled Slot:</span>{' '}
              <strong className="text-ink-900">{formattedScheduled}</strong>
            </div>
          </div>

          {dueItem.instructions && (
            <div className="text-xs italic text-emerald-800">
              Prescriber note: {dueItem.instructions}
            </div>
          )}
        </div>

        {/* Administration Input Fields */}
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Dose Administered <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={doseGiven || `${dueItem.doseAmount} ${dueItem.doseUnit}`}
                onChange={(e) => setDoseGiven(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Route Delivered <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={routeGiven}
                onChange={(e) => setRouteGiven(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 uppercase focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Administration Time <span className="text-rose-500">*</span>
              </label>
              <input
                type="time"
                value={actualTimeStr}
                onChange={(e) => setActualTimeStr(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 font-mono focus:outline-none focus:ring-2 focus:ring-emerald-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Timing Status / Deviation Reason
              </label>
              <select
                value={timingReason}
                onChange={(e) => setTimingReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
              >
                <option value="">Given on time / standard slot</option>
                <option value="Patient away from ward (scan/X-ray/OT)">Patient away from ward (scan/X-ray/OT)</option>
                <option value="Patient was sleeping / resting">Patient was sleeping / resting</option>
                <option value="Delayed after meal / food timing requirement">Delayed after meal / food requirement</option>
                <option value="Doctor verbal instruction to delay">Doctor verbal instruction to delay</option>
                <option value="IV cannula re-siting in progress">IV cannula re-siting in progress</option>
                <option value="Patient requested delay">Patient requested delay</option>
                <option value="Other">Other clinical reason</option>
              </select>
            </div>
          </div>

          {timingReason === 'Other' && (
            <div>
              <label className="block text-xs font-medium text-amber-900">
                Specify Reason for Timing Change <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                placeholder="Document why timing was changed so doctor is informed..."
                value={customTimingReason}
                onChange={(e) => setCustomTimingReason(e.target.value)}
                className="mt-1 w-full rounded-lg border border-amber-300 bg-amber-50/50 px-3 py-2 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-amber-500"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-ink-700">
              Administration Site / Clinical Observation (Optional)
            </label>
            <input
              type="text"
              placeholder="e.g. Left forearm IV cannula, Given with sips of water"
              value={siteNote}
              onChange={(e) => setSiteNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-emerald-500"
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
            onClick={handleConfirm}
            isLoading={isPending}
            className="bg-emerald-600 font-bold hover:bg-emerald-700 px-5"
          >
            ✓ Confirm Dose Administered
          </Button>
        </div>
      </div>
    </div>
  );
}
