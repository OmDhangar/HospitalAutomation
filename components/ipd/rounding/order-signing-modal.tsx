'use client';

import { useState, useTransition } from 'react';
import { Button, cn } from '@/components/ui';
import type { SelectIpdMedicationOrder } from '@/lib/db/schema';
import type {
  DraftOrderInput,
  OrderResolution,
} from '@/lib/services/ipd-medication-orders';
import type { RoundingCockpitData } from '@/lib/services/ipd-rounding-cockpit';
import { signRoundOrdersAction } from '@/app/(app)/ipd/actions';

export interface OrderSigningModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  roundNotes: string;
  activeOrders: SelectIpdMedicationOrder[];
  resolutions: Record<string, OrderResolution>;
  newOrders: DraftOrderInput[];
  allergyAssessment: RoundingCockpitData['allergyAssessment'];
  onSignedSuccess: (result: { roundId: string; signedOrderIds: string[] }) => void;
}

export function OrderSigningModal({
  isOpen,
  onClose,
  admissionId,
  roundNotes,
  activeOrders,
  resolutions,
  newOrders,
  allergyAssessment,
  onSignedSuccess,
}: OrderSigningModalProps) {
  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [allergyAcknowledged, setAllergyAcknowledged] = useState<boolean>(false);
  const [allergyOverrideReason, setAllergyOverrideReason] = useState<string>('');
  const [duplicateOverrideReason, setDuplicateOverrideReason] = useState<string>('');

  if (!isOpen) return null;

  // Group resolutions by action type
  const continuedList: SelectIpdMedicationOrder[] = [];
  const renewedList: Array<{ order: SelectIpdMedicationOrder; newEndsAt: Date }> = [];
  const modifiedList: Array<{
    order: SelectIpdMedicationOrder;
    modified: Partial<DraftOrderInput>;
    reason?: string;
  }> = [];
  const heldList: Array<{ order: SelectIpdMedicationOrder; reason: string }> = [];
  const discontinuedList: Array<{ order: SelectIpdMedicationOrder; reason: string }> = [];

  for (const ord of activeOrders) {
    const res = resolutions[ord.id];
    if (!res || res.type === 'continue') {
      continuedList.push(ord);
    } else if (res.type === 'renew') {
      renewedList.push({ order: ord, newEndsAt: res.newEndsAt });
    } else if (res.type === 'modify') {
      modifiedList.push({ order: ord, modified: res.modifiedOrder, reason: res.reason });
    } else if (res.type === 'hold') {
      heldList.push({ order: ord, reason: res.reason });
    } else if (res.type === 'discontinue') {
      discontinuedList.push({ order: ord, reason: res.reason });
    }
  }

  const handleSign = () => {
    setErrorMsg(null);

    // Validation
    if (!roundNotes.trim()) {
      setErrorMsg('Please document a clinical round evaluation note before signing orders.');
      return;
    }

    for (const item of modifiedList) {
      if (!item.reason?.trim()) {
        setErrorMsg(`A clinical reason is mandatory for modifying ${item.order.medicineName}.`);
        return;
      }
    }

    for (const item of heldList) {
      if (!item.reason?.trim()) {
        setErrorMsg(`A reason is mandatory for holding ${item.order.medicineName}.`);
        return;
      }
    }

    for (const item of discontinuedList) {
      if (!item.reason?.trim()) {
        setErrorMsg(`A reason is mandatory for discontinuing ${item.order.medicineName}.`);
        return;
      }
    }

    if (
      allergyAssessment.status === 'allergies_documented' &&
      allergyAssessment.allergens.length > 0 &&
      !allergyAcknowledged
    ) {
      setErrorMsg(
        'Please acknowledge patient drug allergies before authorizing medication changes.',
      );
      return;
    }

    // Assemble resolutions payload
    const allResolutions: OrderResolution[] = [];

    for (const ord of activeOrders) {
      const res = resolutions[ord.id];
      if (res) {
        allResolutions.push(res);
      } else {
        allResolutions.push({ type: 'continue', orderId: ord.id });
      }
    }

    for (const newOrd of newOrders) {
      allResolutions.push({ type: 'new', order: newOrd });
    }

    startTransition(async () => {
      try {
        const result = await signRoundOrdersAction({
          admissionId,
          notes: roundNotes.trim(),
          resolutions: allResolutions,
          allergyOverrideReason: allergyOverrideReason.trim() || undefined,
          duplicateOverrideReason: duplicateOverrideReason.trim() || undefined,
        });

        onSignedSuccess(result);
        onClose();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to authorize and sign orders');
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="signing-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-ink-200 bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-ink-100 px-6 py-4">
          <div>
            <h3 id="signing-modal-title" className="text-base font-bold text-ink-900">
              Confirm & Sign Clinical Round Orders
            </h3>
            <p className="text-xs text-ink-500">
              Signed orders become immediately actionable in the bedside medication chart.
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

        {/* Scrollable Content Body */}
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4 text-xs">
          {errorMsg && (
            <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 font-medium text-rose-900 space-y-2">
              <div>⚠️ {errorMsg}</div>
              {errorMsg.toLowerCase().includes('allergy') && (
                <div className="pt-2 border-t border-rose-200">
                  <label className="block text-xs font-bold text-rose-950 mb-1">
                    Document Clinical Allergy Override Reason (mandatory, min 5 chars):
                  </label>
                  <input
                    type="text"
                    value={allergyOverrideReason}
                    onChange={(e) => setAllergyOverrideReason(e.target.value)}
                    placeholder="e.g. Desensitization protocol active, monitored under ICU observation"
                    className="w-full rounded border border-rose-300 bg-white p-2 text-xs text-ink-900 focus:outline-rose-500"
                  />
                </div>
              )}
              {errorMsg.toLowerCase().includes('duplicate') && (
                <div className="pt-2 border-t border-rose-200">
                  <label className="block text-xs font-bold text-rose-950 mb-1">
                    Document Duplicate Therapy Override Reason (mandatory, min 5 chars):
                  </label>
                  <input
                    type="text"
                    value={duplicateOverrideReason}
                    onChange={(e) => setDuplicateOverrideReason(e.target.value)}
                    placeholder="e.g. Planned crossover / intentional dual antibiotic coverage"
                    className="w-full rounded border border-rose-300 bg-white p-2 text-xs text-ink-900 focus:outline-rose-500"
                  />
                </div>
              )}
            </div>
          )}

          {/* Allergy acknowledgment if allergies documented */}
          {allergyAssessment.status === 'allergies_documented' &&
            allergyAssessment.allergens.length > 0 && (
              <div className="rounded-xl border border-rose-300 bg-rose-50/80 p-3 text-rose-950">
                <div className="font-semibold text-rose-900 mb-1">
                  ⚠️ Patient has documented drug allergies:
                </div>
                <div className="mb-2 flex flex-wrap gap-1.5">
                  {allergyAssessment.allergens.map((a, i) => (
                    <span
                      key={i}
                      className="rounded bg-rose-200 px-1.5 py-0.5 text-[11px] font-bold text-rose-900"
                    >
                      {a.substance} ({a.severity})
                    </span>
                  ))}
                </div>
                <label className="flex items-center gap-2 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={allergyAcknowledged}
                    onChange={(e) => setAllergyAcknowledged(e.target.checked)}
                    className="size-4 rounded border-rose-300 text-brand-600 focus:ring-brand-500"
                  />
                  <span>
                    I confirm that I have reviewed these allergies and validated prescription safety.
                  </span>
                </label>
              </div>
            )}

          {/* Summary counts badge ribbon */}
          <div className="flex flex-wrap gap-2 rounded-lg border border-ink-100 bg-ink-50/80 p-2.5">
            <span className="font-semibold text-ink-700">Order Actions:</span>
            <span className="text-emerald-700 font-medium">{continuedList.length} Continued</span>
            {renewedList.length > 0 && (
              <span className="text-sky-700 font-medium">• {renewedList.length} Renewed</span>
            )}
            {modifiedList.length > 0 && (
              <span className="text-violet-700 font-medium">• {modifiedList.length} Modified</span>
            )}
            {heldList.length > 0 && (
              <span className="text-amber-700 font-medium">• {heldList.length} Held</span>
            )}
            {discontinuedList.length > 0 && (
              <span className="text-rose-700 font-medium">• {discontinuedList.length} Discontinued</span>
            )}
            {newOrders.length > 0 && (
              <span className="text-emerald-800 font-bold">• {newOrders.length} New Prescriptions</span>
            )}
          </div>

          {/* New Orders */}
          {newOrders.length > 0 && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 p-3 space-y-2">
              <span className="font-bold uppercase tracking-wider text-emerald-900">
                New Inpatient Prescriptions ({newOrders.length})
              </span>
              <ul className="space-y-1 divide-y divide-emerald-100">
                {newOrders.map((no, idx) => (
                  <li key={idx} className="pt-1 flex items-baseline justify-between text-ink-900">
                    <div>
                      <span className="font-semibold">{no.medicineName}</span> —{' '}
                      <span className="font-mono">{no.doseAmount} {no.doseUnit}</span> via{' '}
                      <span className="uppercase">{no.route.replace('_', ' ')}</span> ({no.frequencyCode})
                      {no.isPrn && <span className="text-emerald-700 ml-1">PRN: {no.prnIndication}</span>}
                    </div>
                    <span className="text-ink-500">{no.durationDays} days</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Modified Orders */}
          {modifiedList.length > 0 && (
            <div className="rounded-lg border border-violet-200 bg-violet-50/40 p-3 space-y-2">
              <span className="font-bold uppercase tracking-wider text-violet-900">
                Prescription Modifications ({modifiedList.length})
              </span>
              <ul className="space-y-1.5 divide-y divide-violet-100">
                {modifiedList.map((item, idx) => (
                  <li key={idx} className="pt-1 text-ink-900">
                    <div className="font-semibold text-violet-950">
                      {item.order.medicineName}
                    </div>
                    <div className="text-[11px] text-ink-600">
                      From: {item.order.doseAmount} {item.order.doseUnit} {item.order.route} ({item.order.frequencyCode})
                      {' → '}
                      <span className="font-semibold text-violet-900">
                        To: {item.modified.doseAmount || item.order.doseAmount} {item.modified.doseUnit || item.order.doseUnit}{' '}
                        {item.modified.route || item.order.route} ({item.modified.frequencyCode || item.order.frequencyCode})
                      </span>
                    </div>
                    <div className="italic text-ink-500">
                      Reason: {item.reason || 'None provided'}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Renewed Orders */}
          {renewedList.length > 0 && (
            <div className="rounded-lg border border-sky-200 bg-sky-50/40 p-3 space-y-1">
              <span className="font-bold uppercase tracking-wider text-sky-900">
                Renewed Courses ({renewedList.length})
              </span>
              <ul className="space-y-1">
                {renewedList.map((item, idx) => (
                  <li key={idx} className="flex justify-between text-ink-900">
                    <span className="font-medium">{item.order.medicineName}</span>
                    <span className="text-sky-800">
                      Extended to {new Date(item.newEndsAt).toLocaleDateString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Held Orders */}
          {heldList.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50/40 p-3 space-y-1">
              <span className="font-bold uppercase tracking-wider text-amber-900">
                Held Orders ({heldList.length})
              </span>
              <ul className="space-y-1">
                {heldList.map((item, idx) => (
                  <li key={idx} className="flex justify-between text-ink-900">
                    <span className="font-medium">{item.order.medicineName}</span>
                    <span className="italic text-amber-800">Reason: {item.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Discontinued Orders */}
          {discontinuedList.length > 0 && (
            <div className="rounded-lg border border-rose-200 bg-rose-50/40 p-3 space-y-1">
              <span className="font-bold uppercase tracking-wider text-rose-900">
                Discontinued Orders ({discontinuedList.length})
              </span>
              <ul className="space-y-1">
                {discontinuedList.map((item, idx) => (
                  <li key={idx} className="flex justify-between text-ink-900">
                    <span className="font-medium line-through text-ink-500">
                      {item.order.medicineName}
                    </span>
                    <span className="italic text-rose-800">Reason: {item.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Clinical Note Preview */}
          <div className="rounded-lg border border-ink-200 bg-ink-50/40 p-3">
            <span className="font-bold uppercase tracking-wider text-ink-700">
              Round Note Preview
            </span>
            <p className="mt-1 whitespace-pre-wrap rounded bg-white p-2.5 font-sans text-xs text-ink-800 border border-ink-100">
              {roundNotes.trim() || 'No notes documented.'}
            </p>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t border-ink-100 bg-ink-50/50 px-6 py-4">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isPending}
          >
            Back to Cockpit
          </Button>

          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSign}
            isLoading={isPending}
            className="bg-brand-600 font-bold hover:bg-brand-700 px-5"
          >
            Authorize & Sign Orders
          </Button>
        </div>
      </div>
    </div>
  );
}
