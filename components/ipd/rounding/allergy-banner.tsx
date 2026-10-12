'use client';

import { useState, useTransition } from 'react';
import { Button, cn } from '@/components/ui';
import type { AllergenItem, RoundingCockpitData } from '@/lib/services/ipd-rounding-cockpit';
import { recordAllergyAssessmentAction } from '@/app/(app)/ipd/actions';

export interface AllergyBannerProps {
  admissionId: string;
  assessment: RoundingCockpitData['allergyAssessment'];
  onUpdated?: () => void;
  readOnly?: boolean;
  className?: string;
}

export function AllergyBanner({
  admissionId,
  assessment,
  onUpdated,
  readOnly = false,
  className,
}: AllergyBannerProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Form state inside modal
  const [modalStatus, setModalStatus] = useState<'nkda' | 'allergies_documented'>(
    assessment.status === 'allergies_documented' ? 'allergies_documented' : 'nkda',
  );
  const [allergens, setAllergens] = useState<AllergenItem[]>(
    assessment.allergens.length > 0
      ? assessment.allergens
      : [{ substance: '', reaction: '', severity: 'moderate' }],
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const openModal = (initialStatus?: 'nkda' | 'allergies_documented') => {
    setModalStatus(initialStatus ?? (assessment.status === 'allergies_documented' ? 'allergies_documented' : 'nkda'));
    setAllergens(
      assessment.allergens.length > 0
        ? [...assessment.allergens]
        : [{ substance: '', reaction: '', severity: 'moderate' }],
    );
    setErrorMsg(null);
    setIsModalOpen(true);
  };

  const handleQuickNkda = () => {
    startTransition(async () => {
      try {
        await recordAllergyAssessmentAction({
          admissionId,
          status: 'nkda',
        });
        onUpdated?.();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to record no allergies');
      }
    });
  };

  const handleSaveModal = () => {
    setErrorMsg(null);
    if (modalStatus === 'allergies_documented') {
      const validAllergens = allergens.filter((a) => a.substance.trim().length > 0);
      if (validAllergens.length === 0) {
        setErrorMsg('Please enter at least one allergen substance name.');
        return;
      }
    }

    startTransition(async () => {
      try {
        const cleanAllergens = modalStatus === 'allergies_documented'
          ? allergens
              .filter((a) => a.substance.trim().length > 0)
              .map((a) => ({
                substance: a.substance.trim(),
                reaction: a.reaction?.trim() || undefined,
                severity: a.severity || 'moderate',
              }))
          : [];

        await recordAllergyAssessmentAction({
          admissionId,
          status: modalStatus,
          allergens: cleanAllergens,
        });

        setIsModalOpen(false);
        onUpdated?.();
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to save allergy assessment');
      }
    });
  };

  const addAllergenRow = () => {
    setAllergens([...allergens, { substance: '', reaction: '', severity: 'moderate' }]);
  };

  const updateAllergenRow = (index: number, patch: Partial<AllergenItem>) => {
    setAllergens(allergens.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const removeAllergenRow = (index: number) => {
    if (allergens.length <= 1) {
      setAllergens([{ substance: '', reaction: '', severity: 'moderate' }]);
    } else {
      setAllergens(allergens.filter((_, i) => i !== index));
    }
  };

  const formattedDate = assessment.reviewedAt
    ? new Date(assessment.reviewedAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;

  return (
    <>
      {assessment.status === 'unreviewed' && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 rounded-xl border-2 border-amber-400 bg-amber-50 p-3.5 text-amber-950 shadow-xs',
            className,
          )}
        >
          <div className="flex items-center gap-2.5">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-200 text-amber-900 font-bold text-sm">
              !
            </span>
            <div>
              <p className="font-semibold text-amber-950">
                Allergy Assessment Required
              </p>
              <p className="text-xs text-amber-800">
                Patient has no documented allergy history. Verify prior to authorizing inpatient orders.
              </p>
            </div>
          </div>

          {!readOnly && (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleQuickNkda}
                disabled={isPending}
                className="inline-flex items-center rounded-lg border border-emerald-400 bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-xs transition hover:bg-emerald-700 disabled:opacity-50"
              >
                {isPending ? 'Saving...' : '✓ No Allergies'}
              </button>
              <button
                type="button"
                onClick={() => openModal('allergies_documented')}
                disabled={isPending}
                className="inline-flex items-center rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs font-semibold text-amber-950 shadow-xs transition hover:bg-amber-100 disabled:opacity-50"
              >
                + Add Known Allergies
              </button>
            </div>
          )}
        </div>
      )}

      {assessment.status === 'nkda' && (
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3 text-emerald-950 shadow-xs',
            className,
          )}
        >
          <div className="flex items-center gap-2.5">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-700 font-bold text-xs">
              ✓
            </span>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-sm font-semibold text-emerald-950">
                No allergies
              </span>
              {formattedDate && (
                <span className="text-xs text-emerald-700">
                  Reviewed by {assessment.reviewedByUserName || 'Doctor'} on {formattedDate}
                </span>
              )}
            </div>
          </div>

          {!readOnly && (
            <button
              type="button"
              onClick={() => openModal()}
              className="text-xs font-semibold text-emerald-800 hover:text-emerald-950 hover:underline"
            >
              Update / Add Allergies &rarr;
            </button>
          )}
        </div>
      )}

      {assessment.status === 'allergies_documented' && (
        <div
          className={cn(
            'rounded-xl border-2 border-rose-500 bg-rose-50/90 p-3.5 shadow-sm',
            className,
          )}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-rose-200 pb-2">
            <div className="flex items-center gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-600 text-white font-bold text-xs">
                !
              </span>
              <span className="text-xs font-bold uppercase tracking-wider text-rose-900">
                Documented Drug Allergies
              </span>
              {formattedDate && (
                <span className="text-xs text-rose-700">
                  (Reviewed {formattedDate} by {assessment.reviewedByUserName || 'Doctor'})
                </span>
              )}
            </div>

            {!readOnly && (
              <button
                type="button"
                onClick={() => openModal()}
                className="text-xs font-semibold text-rose-800 hover:text-rose-950 hover:underline"
              >
                Edit Allergies &rarr;
              </button>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap gap-2">
            {assessment.allergens.map((item, idx) => (
              <div
                key={idx}
                className="inline-flex items-center gap-2 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-xs text-rose-950 shadow-xs"
              >
                <span className="font-semibold text-rose-900">{item.substance}</span>
                {item.reaction && (
                  <span className="text-ink-600">({item.reaction})</span>
                )}
                {item.severity && (
                  <span
                    className={cn(
                      'rounded-full px-1.5 py-0.2 text-[10px] font-semibold uppercase',
                      item.severity === 'severe'
                        ? 'bg-rose-100 text-rose-700'
                        : item.severity === 'moderate'
                          ? 'bg-amber-100 text-amber-800'
                          : 'bg-ink-100 text-ink-700',
                    )}
                  >
                    {item.severity}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Assessment Modal Dialog */}
      {isModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="allergy-dialog-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-xs"
        >
          <div className="w-full max-w-lg rounded-xl border border-ink-200 bg-white p-5 shadow-xl">
            <h3 id="allergy-dialog-title" className="text-base font-semibold text-ink-900">
              Record Patient Allergy Assessment
            </h3>
            <p className="mt-1 text-xs text-ink-500">
              This assessment updates the patient safety banner and warns nursing and prescribing staff.
            </p>

            {errorMsg && (
              <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 text-xs text-rose-800">
                {errorMsg}
              </div>
            )}

            {/* Assessment Status Toggle */}
            <div className="mt-4 flex gap-2 rounded-lg border border-ink-200 bg-ink-50 p-1">
              <button
                type="button"
                onClick={() => setModalStatus('nkda')}
                className={cn(
                  'flex-1 rounded-md py-1.5 text-xs font-semibold transition',
                  modalStatus === 'nkda'
                    ? 'bg-white text-emerald-800 shadow-xs'
                    : 'text-ink-600 hover:text-ink-900',
                )}
              >
                ✓ No allergies
              </button>
              <button
                type="button"
                onClick={() => setModalStatus('allergies_documented')}
                className={cn(
                  'flex-1 rounded-md py-1.5 text-xs font-semibold transition',
                  modalStatus === 'allergies_documented'
                    ? 'bg-white text-rose-800 shadow-xs'
                    : 'text-ink-600 hover:text-ink-900',
                )}
              >
                ⚠️ Specific Drug Allergies
              </button>
            </div>

            {modalStatus === 'nkda' ? (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 text-center">
                <p className="text-sm font-medium text-emerald-950">
                  Confirm No Allergies
                </p>
                <p className="mt-1 text-xs text-emerald-700">
                  You are verifying that the patient has denied known adverse reactions to medications.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <div className="max-h-60 space-y-2 overflow-y-auto pr-1">
                  {allergens.map((item, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-2 rounded-lg border border-ink-200 bg-ink-50/40 p-2"
                    >
                      <input
                        type="text"
                        placeholder="Drug / Substance (e.g. Penicillin)"
                        value={item.substance}
                        onChange={(e) => updateAllergenRow(index, { substance: e.target.value })}
                        className="flex-1 rounded-md border border-ink-200 bg-white px-2.5 py-1 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                      <input
                        type="text"
                        placeholder="Reaction (e.g. Rash, Anaphylaxis)"
                        value={item.reaction || ''}
                        onChange={(e) => updateAllergenRow(index, { reaction: e.target.value })}
                        className="w-36 rounded-md border border-ink-200 bg-white px-2.5 py-1 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      />
                      <select
                        value={item.severity || 'moderate'}
                        onChange={(e) =>
                          updateAllergenRow(index, {
                            severity: e.target.value as AllergenItem['severity'],
                          })
                        }
                        className="rounded-md border border-ink-200 bg-white px-2 py-1 text-xs text-ink-900 focus:outline-none focus:ring-1 focus:ring-brand-500"
                      >
                        <option value="mild">Mild</option>
                        <option value="moderate">Moderate</option>
                        <option value="severe">Severe</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeAllergenRow(index)}
                        className="rounded p-1 text-ink-400 hover:bg-ink-100 hover:text-rose-600"
                        title="Remove allergen"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={addAllergenRow}
                  className="text-xs font-semibold text-brand-700 hover:underline"
                >
                  + Add another allergen
                </button>
              </div>
            )}

            <div className="mt-6 flex justify-end gap-2 border-t border-ink-100 pt-3">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setIsModalOpen(false)}
                disabled={isPending}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleSaveModal}
                isLoading={isPending}
              >
                Save Assessment
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
