'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import { recordNurseUrgentAdministrationAction } from '@/app/(app)/ipd/actions';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';

export interface NurseUrgentAdminModalProps {
  isOpen: boolean;
  onClose: () => void;
  admissionId: string;
  patientName: string;
  bedLabel?: string;
  activeAllergies?: AllergenItem[];
  onSuccess: (orderId: string, administrationId: string) => void;
}

interface QuickPickPreset {
  name: string;
  dose: string;
  unit: string;
  route: string;
  commonReason: string;
}

const EMERGENCY_PRESETS: QuickPickPreset[] = [
  {
    name: 'Paracetamol IV 1g Infusion',
    dose: '1',
    unit: 'g',
    route: 'iv_piggyback',
    commonReason: 'Acute fever spike > 101°F with chills and rigors',
  },
  {
    name: 'Ondansetron 4mg Injection',
    dose: '4',
    unit: 'mg',
    route: 'iv_push',
    commonReason: 'Acute intractable nausea and persistent vomiting',
  },
  {
    name: 'Pantoprazole 40mg Injection',
    dose: '40',
    unit: 'mg',
    route: 'iv_push',
    commonReason: 'Acute epigastric burning / stress ulcer prophylaxis',
  },
  {
    name: 'Tramadol 50mg Injection',
    dose: '50',
    unit: 'mg',
    route: 'iv_push',
    commonReason: 'Severe breakthrough postoperative pain',
  },
  {
    name: 'Salbutamol Nebulizer Solution 2.5mg',
    dose: '2.5',
    unit: 'mg',
    route: 'nebulization',
    commonReason: 'Acute bronchospasm, dyspnea and bilateral wheezing',
  },
  {
    name: 'Dextrose 25% 100ml Infusion',
    dose: '25',
    unit: 'g',
    route: 'iv_push',
    commonReason: 'Severe acute symptomatic hypoglycemia (GRBS < 60 mg/dL)',
  },
  {
    name: 'Avil (Pheniramine) 22.75mg Injection',
    dose: '22.75',
    unit: 'mg',
    route: 'iv_push',
    commonReason: 'Acute allergic urticaria / pruritus reaction',
  },
  {
    name: 'Hydrocortisone 100mg Injection',
    dose: '100',
    unit: 'mg',
    route: 'iv_push',
    commonReason: 'Acute anaphylaxis / severe inflammatory reaction',
  },
];

export function NurseUrgentAdminModal({
  isOpen,
  onClose,
  admissionId,
  patientName,
  bedLabel,
  activeAllergies = [],
  onSuccess,
}: NurseUrgentAdminModalProps) {
  const [isPending, startTransition] = useTransition();

  const [medicineName, setMedicineName] = useState('');
  const [doseAmount, setDoseAmount] = useState('1');
  const [doseUnit, setDoseUnit] = useState('amp');
  const [route, setRoute] = useState('iv_push');
  const [actualTimeStr, setActualTimeStr] = useState<string>(() => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  });

  const [authority, setAuthority] = useState<'verbal_order' | 'standing_protocol' | 'acute_emergency'>(
    'verbal_order',
  );
  const [doctorNameOrNote, setDoctorNameOrNote] = useState('');
  const [clinicalRationale, setClinicalRationale] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  if (!isOpen) return null;

  // Cross-reference against documented drug allergies
  const matchedAllergy = activeAllergies.find((al) => {
    if (!medicineName) return false;
    const medLower = medicineName.toLowerCase();
    const subLower = al.substance.toLowerCase();
    return medLower.includes(subLower) || subLower.includes(medLower);
  });

  const handleApplyPreset = (preset: QuickPickPreset) => {
    setMedicineName(preset.name);
    setDoseAmount(preset.dose);
    setDoseUnit(preset.unit);
    setRoute(preset.route);
    if (!clinicalRationale) {
      setClinicalRationale(preset.commonReason);
    }
  };

  const handleConfirm = () => {
    setErrorMsg(null);
    if (!medicineName.trim()) {
      setErrorMsg('Please specify the medication name.');
      return;
    }
    if (!doseAmount.trim()) {
      setErrorMsg('Please enter the dose amount.');
      return;
    }
    if (!clinicalRationale.trim() || clinicalRationale.trim().length < 3) {
      setErrorMsg('A detailed clinical rationale (e.g. symptom, vital signs) is required for urgent nurse administration.');
      return;
    }
    if (authority === 'verbal_order' && !doctorNameOrNote.trim()) {
      setErrorMsg('Please enter the doctor name or telephone conversation details for verbal orders.');
      return;
    }

    startTransition(async () => {
      try {
        let actualTime = new Date();
        if (actualTimeStr) {
          const [h, m] = actualTimeStr.split(':').map(Number);
          if (!isNaN(h) && !isNaN(m)) {
            actualTime = new Date();
            actualTime.setHours(h, m, 0, 0);
          }
        }

        const res = await recordNurseUrgentAdministrationAction({
          admissionId,
          input: {
            medicineName: medicineName.trim(),
            doseAmount: doseAmount.trim(),
            doseUnit: doseUnit.trim(),
            route: route.trim(),
            actualTime,
            authority:
              authority === 'verbal_order'
                ? 'Verbal Order from Doctor'
                : authority === 'standing_protocol'
                ? 'Emergency Standing Nursing Protocol'
                : 'Acute Clinical Deterioration / Emergency',
            doctorNameOrNote: doctorNameOrNote.trim() || undefined,
            clinicalRationale: clinicalRationale.trim(),
          },
        });

        if (res.ok) {
          onSuccess(res.orderId, res.administrationId);
          onClose();
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : 'Failed to record urgent administration');
      }
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="urgent-med-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
    >
      <div className="w-full max-w-xl max-h-[90vh] overflow-y-auto rounded-2xl border-2 border-rose-300 bg-white p-5 shadow-2xl">
        <div className="flex items-center justify-between border-b border-ink-100 pb-3">
          <div>
            <h3 id="urgent-med-modal-title" className="text-base font-black text-rose-950 flex items-center gap-1.5">
              <span>🚨</span> Urgent / Emergency Nurse Administration
            </h3>
            <p className="text-xs text-ink-500">
              Administer urgent STAT medications. Automatically bills and flags for doctor review during rounds.
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

        {/* Allergy Warning if matched */}
        {matchedAllergy && (
          <div className="mt-3 rounded-xl border-2 border-rose-600 bg-rose-100 p-3 text-xs text-rose-950 font-bold">
            ⚠️ CONTRAINDICATION ALERT: Patient has a documented allergy to {matchedAllergy.substance} ({matchedAllergy.severity || 'severe'} severity). Do not administer unless expressly verified!
          </div>
        )}

        {/* Patient header */}
        <div className="mt-3 flex items-center justify-between rounded-lg border border-ink-200 bg-ink-50/70 p-2.5">
          <div>
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-400">
              Patient
            </span>
            <p className="text-xs font-bold text-ink-900">{patientName}</p>
          </div>
          {bedLabel && (
            <span className="rounded-md border border-brand-300 bg-brand-50 px-2 py-0.5 text-xs font-bold text-brand-800">
              Bed {bedLabel}
            </span>
          )}
        </div>

        {/* Quick Emergency Presets */}
        <div className="mt-3.5">
          <label className="block text-xs font-bold text-ink-800">
            Emergency Quick-Picks (Tap to auto-fill):
          </label>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {EMERGENCY_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => handleApplyPreset(p)}
                className="rounded-lg border border-rose-200 bg-rose-50/70 px-2 py-1 text-xs font-semibold text-rose-900 hover:bg-rose-100 transition"
              >
                + {p.name}
              </button>
            ))}
          </div>
        </div>

        {/* Medication Details Form */}
        <div className="mt-4 space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-700">
              Medication Name <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              placeholder="e.g. Paracetamol IV 1g Infusion, Ondansetron 4mg, Tramadol 50mg"
              value={medicineName}
              onChange={(e) => setMedicineName(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 font-bold focus:outline-none focus:ring-2 focus:ring-rose-500"
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Dose Amount <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={doseAmount}
                onChange={(e) => setDoseAmount(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs font-mono text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Unit <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                placeholder="mg, g, ml, amp"
                value={doseUnit}
                onChange={(e) => setDoseUnit(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Route <span className="text-rose-500">*</span>
              </label>
              <select
                value={route}
                onChange={(e) => setRoute(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-2 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              >
                <option value="iv_push">IV Push</option>
                <option value="iv_piggyback">IV Drip / Infusion</option>
                <option value="oral">Oral</option>
                <option value="nebulization">Nebulization</option>
                <option value="im">IM</option>
                <option value="sc">Subcutaneous</option>
                <option value="sublingual">Sublingual</option>
                <option value="inhalation">Inhalation</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Time Given <span className="text-rose-500">*</span>
              </label>
              <input
                type="time"
                value={actualTimeStr}
                onChange={(e) => setActualTimeStr(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs font-mono text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Clinical Authority <span className="text-rose-500">*</span>
              </label>
              <select
                value={authority}
                onChange={(e) => setAuthority(e.target.value as any)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-2 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              >
                <option value="verbal_order">Verbal / Telephone Order from Doctor</option>
                <option value="standing_protocol">Emergency Standing Nursing Protocol</option>
                <option value="acute_emergency">Acute Clinical Deterioration / Stat PRN</option>
              </select>
            </div>
          </div>

          {authority === 'verbal_order' && (
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Doctor Name / Order Call Record <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                placeholder="e.g. Dr. Sharma (Phone order at 09:15 AM)"
                value={doctorNameOrNote}
                onChange={(e) => setDoctorNameOrNote(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-rose-500"
              />
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-ink-700">
              Clinical Rationale / Patient Symptoms <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={2}
              placeholder="e.g. Patient developed sudden fever spike of 103°F with severe shivering and body ache..."
              value={clinicalRationale}
              onChange={(e) => setClinicalRationale(e.target.value)}
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-2 focus:ring-rose-500"
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
            className="bg-rose-700 font-bold hover:bg-rose-800 px-5"
          >
            ✓ Confirm Urgent Administration
          </Button>
        </div>
      </div>
    </div>
  );
}
