'use client';

import { useMemo, useState, useTransition } from 'react';
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

  // 10-minute grace buffer: doses up to 10 minutes past scheduled time are on-time
  const BUFFER_MINUTES = 10;

  const { delayMinutes, isDelayed, isWithinBuffer } = useMemo(() => {
    if (!dueItem?.scheduledTime) {
      return { delayMinutes: 0, isDelayed: false, isWithinBuffer: false };
    }
    const scheduled = new Date(dueItem.scheduledTime);
    let actual = new Date(scheduled);
    if (actualTimeStr) {
      const [h, m] = actualTimeStr.split(':').map(Number);
      if (!isNaN(h) && !isNaN(m)) {
        actual.setHours(h, m, 0, 0);
        // Handle crossover across midnight if scheduled at 23:50 and given at 00:05
        if (actual.getTime() - scheduled.getTime() < -12 * 3600000) {
          actual.setDate(actual.getDate() + 1);
        } else if (actual.getTime() - scheduled.getTime() > 12 * 3600000) {
          actual.setDate(actual.getDate() - 1);
        }
      }
    }
    const diffMs = actual.getTime() - scheduled.getTime();
    const diffMins = Math.round(diffMs / 60000);
    const delayed = diffMins > BUFFER_MINUTES;
    const withinBuffer = diffMins >= 0 && diffMins <= BUFFER_MINUTES;
    return { delayMinutes: diffMins, isDelayed: delayed, isWithinBuffer: withinBuffer };
  }, [actualTimeStr, dueItem?.scheduledTime]);

  const handleConfirm = () => {
    setErrorMsg(null);
    if (!doseGiven.trim()) {
      setErrorMsg('Please specify the dose given.');
      return;
    }

    const effectiveReason = timingReason === 'Other' ? customTimingReason.trim() : timingReason.trim();

    // If medication is delayed past the 10-minute buffer, require a specific clinical delay reason
    if (isDelayed) {
      if (!effectiveReason) {
        setErrorMsg(
          `This medication is delayed by ${delayMinutes} minutes (past the 10-minute buffer). You have delayed this medication — please select a clinical reason for the delay.`,
        );
        return;
      }
      if (timingReason === 'Other' && !customTimingReason.trim()) {
        setErrorMsg('Please specify the clinical reason for the medication delay.');
        return;
      }
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

        let finalClinicalNote = siteNote.trim();
        if (effectiveReason) {
          const timingPrefix = isDelayed
            ? `[Timing deviation: Scheduled ${formattedScheduled}, Given at ${actualTimeStr} (+${delayMinutes}m late) — Reason: ${effectiveReason}]`
            : `[Timing note: ${effectiveReason}]`;
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

          {/* Timing Buffer & Delay Indication Banner */}
          {isDelayed ? (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 space-y-1 shadow-2xs">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 font-bold text-amber-900">
                  <span>⚠️</span> Medication Delayed
                </span>
                <span className="rounded-md bg-amber-200 px-2 py-0.5 text-[11px] font-bold text-amber-900">
                  +{delayMinutes} min late
                </span>
              </div>
              <p className="text-amber-900 leading-relaxed">
                This dose was scheduled for <strong>{formattedScheduled}</strong> and is being given at <strong>{actualTimeStr}</strong> ({delayMinutes} minutes late, exceeds 10-minute buffer). You have delayed this medication — <strong>please select a clinical reason for the delay</strong>.
              </p>
            </div>
          ) : isWithinBuffer ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-medium text-emerald-900">
              <span className="font-bold text-emerald-800">✓ On Time:</span>
              <span className="text-emerald-700">
                {delayMinutes > 0
                  ? `Given within the 10-minute buffer window (+${delayMinutes}m). No delay reason required.`
                  : 'Given on scheduled slot.'}
              </span>
            </div>
          ) : null}

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
              <label className={cn('block text-xs font-medium', isDelayed ? 'font-bold text-amber-900' : 'text-ink-700')}>
                {isDelayed ? (
                  <>
                    Reason for Delay <span className="text-rose-500">* (Required)</span>
                  </>
                ) : (
                  'Clinical Timing Note (Optional)'
                )}
              </label>
              <select
                value={timingReason}
                onChange={(e) => setTimingReason(e.target.value)}
                className={cn(
                  'mt-1 w-full rounded-lg border px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2',
                  isDelayed
                    ? 'border-amber-400 bg-amber-50/40 focus:ring-amber-500'
                    : 'border-ink-300 bg-white focus:ring-emerald-500',
                )}
              >
                {isDelayed ? (
                  <option value="">-- Select reason for delay * --</option>
                ) : (
                  <option value="">Given on time / standard slot</option>
                )}
                <option value="Patient away from ward (scan/X-ray/OT)">Patient away from ward (scan/X-ray/OT)</option>
                <option value="Patient was sleeping / resting">Patient was sleeping / resting</option>
                <option value="Delayed after meal / food timing requirement">Delayed after meal / food timing requirement</option>
                <option value="Doctor verbal instruction to delay">Doctor verbal instruction to delay</option>
                <option value="IV cannula re-siting in progress">IV cannula re-siting in progress</option>
                <option value="Patient requested delay">Patient requested delay</option>
                <option value="Nurse occupied with emergency / critical patient">Nurse occupied with emergency / critical patient</option>
                <option value="Pharmacy delivery / medication supply delay">Pharmacy delivery / medication supply delay</option>
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
