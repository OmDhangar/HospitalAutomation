'use client';

import { useState, useTransition } from 'react';
import { Button, cn } from '@/components/ui';
import type { BedsidePrnItem } from '@/lib/services/ipd-emar';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';
import { recordAdministrationAction } from '@/app/(app)/ipd/actions';

export interface PrnAdminModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  prnItem: BedsidePrnItem | null;
  patientName: string;
  activeAllergies?: AllergenItem[];
  onSuccess: (administrationId: string) => void;
}

export function PrnAdminModal({
  isOpen,
  onClose,
  admissionId,
  prnItem,
  patientName,
  activeAllergies = [],
  onSuccess,
}: PrnAdminModalProps) {
  const [isPending, startTransition] = useTransition();
  const [doseGiven, setDoseGiven] = useState<string>(
    prnItem ? `${prnItem.doseAmount} ${prnItem.doseUnit}` : '',
  );
  const [routeGiven, setRouteGiven] = useState<string>(
    prnItem ? prnItem.route : 'oral',
  );
  const [clinicalNote, setClinicalNote] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen || !prnItem) return null;

  // Cross-reference against active drug allergies
  const allergyAlert = activeAllergies.find((allergy) => {
    const medLower = prnItem.medicineName.toLowerCase();
    const substanceLower = allergy.substance.toLowerCase();
    return medLower.includes(substanceLower) || substanceLower.includes(medLower);
  });

  const handleConfirm = () => {
    setErrorMsg(null);
    if (!doseGiven.trim()) {
      setErrorMsg('Please specify the dose given.');
      return;
    }

    startTransition(async () => {
      try {
        const res = await recordAdministrationAction({
          admissionId,
          orderId: prnItem.orderId,
          input: {
            clientId: crypto.randomUUID(),
            scheduledTime: null,
            actualTime: new Date(),
            doseAmount: prnItem.doseAmount,
            doseGiven: doseGiven.trim(),
            routeGiven: routeGiven,
            clinicalNote: clinicalNote.trim() || undefined,
            recordedChannel: 'ward_device',
          },
        });

        onSuccess(res.administrationId);
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to record PRN administration');
      }
    });
  };

  const isEligible = prnItem.eligibility.eligible;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="prn-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 id="prn-dialog-title" className="text-base font-bold text-ink-900">
              Administer PRN (As Needed / SOS) Medication
            </h3>
            <p className="text-xs text-ink-500">
              Verify documented indication, cooldown interval, and daily allowances.
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
            <span className="underline font-bold">{allergyAlert.substance}</span> ({allergyAlert.severity}).
          </div>
        )}

        {/* PRN Medication Details */}
        <div className="mt-3 rounded-xl border border-sky-200 bg-sky-50/40 p-3.5 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-base font-bold text-sky-950">
              {prnItem.medicineName}
            </span>
            <span className="rounded bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-900 uppercase">
              {prnItem.route.replace('_', ' ')}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <span className="text-ink-500">Authorized Dose:</span>{' '}
              <strong className="text-ink-900 font-mono">
                {prnItem.doseAmount} {prnItem.doseUnit}
              </strong>
            </div>
            <div>
              <span className="text-ink-500">Remaining Allowed:</span>{' '}
              <strong className="text-ink-900">
                {prnItem.eligibility.dosesRemainingToday ?? 'Unlimited'} doses today
              </strong>
            </div>
          </div>

          {prnItem.prnIndication && (
            <div className="rounded-md border border-sky-200 bg-white p-2 text-xs">
              <span className="font-semibold text-sky-900">Documented Indication:</span>{' '}
              <span className="text-ink-900 font-medium">{prnItem.prnIndication}</span>
            </div>
          )}

          {!isEligible && prnItem.eligibility.reason && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 font-semibold">
              ⚠️ Ineligible for administration: {prnItem.eligibility.reason}
            </div>
          )}
        </div>

        {/* Dosing Inputs */}
        <div className="mt-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Dose Administered <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={doseGiven || `${prnItem.doseAmount} ${prnItem.doseUnit}`}
                onChange={(e) => setDoseGiven(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 font-mono focus:outline-none focus:ring-2 focus:ring-sky-500"
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
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 uppercase focus:outline-none focus:ring-2 focus:ring-sky-500"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-700">
              Current Patient Symptom / Vitals Justification
            </label>
            <input
              type="text"
              placeholder="e.g. Temperature 101.5°F recorded, Patient complained of headache"
              value={clinicalNote}
              onChange={(e) => setClinicalNote(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-sky-500"
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
            disabled={!isEligible}
            className="bg-sky-600 font-bold hover:bg-sky-700 px-5 text-white disabled:opacity-50"
          >
            ✓ Confirm PRN Dose
          </Button>
        </div>
      </div>
    </div>
  );
}
