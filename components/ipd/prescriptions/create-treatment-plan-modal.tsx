'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createTreatmentPlanAction } from '@/app/(app)/ipd/actions';
import type { DraftOrderInput } from '@/lib/services/ipd-medication-orders';
import { PlusIcon, XIcon, CheckIcon } from '@/components/icons';

export interface CreateTreatmentPlanModalProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  patientName?: string;
  initialDiagnosis?: string | null;
  doctorId?: string;
}

const COMMON_IPD_PRESETS: Array<{
  label: string;
  category: string;
  order: DraftOrderInput;
}> = [
  {
    label: 'RL 500ml IV',
    category: 'IV Fluids',
    order: {
      medicineId: '',
      medicineName: 'Ringer Lactate 500ml IV Infusion',
      doseAmount: '500',
      doseUnit: 'ml',
      route: 'iv_push',
      frequencyCode: 'OD',
      scheduleTimes: ['08:00'],
      scheduleType: 'scheduled',
      durationDays: 1,
      specialInstructions: 'IV infusion over 4 hours at 40 drops/min',
    },
  },
  {
    label: 'NS 500ml IV',
    category: 'IV Fluids',
    order: {
      medicineId: '',
      medicineName: 'Normal Saline 0.9% 500ml IV',
      doseAmount: '500',
      doseUnit: 'ml',
      route: 'iv_push',
      frequencyCode: 'OD',
      scheduleTimes: ['08:00'],
      scheduleType: 'scheduled',
      durationDays: 1,
      specialInstructions: 'IV infusion over 4 hours',
    },
  },
  {
    label: 'Pantoprazole 40mg IV',
    category: 'PPI / Antacid',
    order: {
      medicineId: '',
      medicineName: 'Pantoprazole 40mg IV',
      doseAmount: '40',
      doseUnit: 'mg',
      route: 'iv_push',
      frequencyCode: 'OD',
      scheduleTimes: ['08:00'],
      scheduleType: 'scheduled',
      durationDays: 3,
      specialInstructions: 'Give before morning breakfast',
    },
  },
  {
    label: 'Ondansetron 4mg IV',
    category: 'Antiemetic',
    order: {
      medicineId: '',
      medicineName: 'Ondansetron 4mg IV',
      doseAmount: '4',
      doseUnit: 'mg',
      route: 'iv_push',
      frequencyCode: 'PRN',
      scheduleType: 'prn',
      isPrn: true,
      prnIndication: 'For nausea or vomiting (SOS)',
      prnMinIntervalHours: 8,
      prnMaxDailyDoses: 3,
      durationDays: 3,
      specialInstructions: 'Slow IV injection over 2 minutes',
    },
  },
  {
    label: 'Ceftriaxone 1g IV',
    category: 'Antibiotic',
    order: {
      medicineId: '',
      medicineName: 'Ceftriaxone 1g IV',
      doseAmount: '1',
      doseUnit: 'g',
      route: 'iv_push',
      frequencyCode: 'BD',
      scheduleTimes: ['08:00', '20:00'],
      scheduleType: 'scheduled',
      durationDays: 5,
      specialInstructions: 'Slow IV injection over 5 minutes after test dose',
    },
  },
  {
    label: 'Paracetamol 650mg Oral',
    category: 'Analgesic / Fever',
    order: {
      medicineId: '',
      medicineName: 'Paracetamol 650mg Oral',
      doseAmount: '650',
      doseUnit: 'mg',
      route: 'oral',
      frequencyCode: 'PRN',
      scheduleType: 'prn',
      isPrn: true,
      prnIndication: 'For fever > 100°F or body pain (SOS)',
      prnMinIntervalHours: 6,
      prnMaxDailyDoses: 4,
      durationDays: 3,
      specialInstructions: 'Take with warm water after food',
    },
  },
  {
    label: 'Tramadol 50mg IV',
    category: 'Pain Relief',
    order: {
      medicineId: '',
      medicineName: 'Tramadol 50mg IV',
      doseAmount: '50',
      doseUnit: 'mg',
      route: 'iv_push',
      frequencyCode: 'PRN',
      scheduleType: 'prn',
      isPrn: true,
      prnIndication: 'For severe breakthrough pain (SOS)',
      prnMinIntervalHours: 8,
      prnMaxDailyDoses: 2,
      durationDays: 2,
      specialInstructions: 'Dilute in 10ml NS and give slow IV',
    },
  },
  {
    label: 'Metronidazole 500mg IV',
    category: 'Antibiotic',
    order: {
      medicineId: '',
      medicineName: 'Metronidazole 500mg IV Infusion',
      doseAmount: '500',
      doseUnit: 'mg',
      route: 'iv_piggyback',
      frequencyCode: 'TDS',
      scheduleTimes: ['08:00', '14:00', '20:00'],
      scheduleType: 'scheduled',
      durationDays: 3,
      specialInstructions: 'Infuse over 30 minutes',
    },
  },
];

const ROUTE_OPTIONS: Array<{ id: DraftOrderInput['route']; label: string }> = [
  { id: 'oral', label: 'Oral (PO)' },
  { id: 'iv_push', label: 'IV Push' },
  { id: 'iv_piggyback', label: 'IV Infusion / Piggyback' },
  { id: 'im', label: 'Intramuscular (IM)' },
  { id: 'sc', label: 'Subcutaneous (SC)' },
  { id: 'nebulization', label: 'Nebulization' },
  { id: 'sublingual', label: 'Sublingual' },
  { id: 'inhalation', label: 'Inhalation' },
];

const FREQ_PRESETS: Record<string, { times: string[]; defaultDays: number; isPrn?: boolean }> = {
  OD: { times: ['08:00'], defaultDays: 3 },
  BD: { times: ['08:00', '20:00'], defaultDays: 5 },
  TDS: { times: ['08:00', '14:00', '20:00'], defaultDays: 3 },
  QID: { times: ['06:00', '12:00', '18:00', '00:00'], defaultDays: 2 },
  STAT: { times: ['08:00'], defaultDays: 1 },
  PRN: { times: [], defaultDays: 3, isPrn: true },
};

export function CreateTreatmentPlanModal({
  admissionId,
  isOpen,
  onClose,
  patientName = 'Patient',
  initialDiagnosis = '',
  doctorId,
}: CreateTreatmentPlanModalProps) {
  let router: { refresh: () => void } | null = null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }

  const [isPending, startTransition] = useTransition();
  const [diagnosis, setDiagnosis] = useState(initialDiagnosis || '');
  const [planNotes, setPlanNotes] = useState('');
  const [stagedOrders, setStagedOrders] = useState<DraftOrderInput[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [allergyOverrideReason, setAllergyOverrideReason] = useState('');
  const [duplicateOverrideReason, setDuplicateOverrideReason] = useState('');

  // Custom order form fields
  const [customMedName, setCustomMedName] = useState('');
  const [customDose, setCustomDose] = useState('');
  const [customUnit, setCustomUnit] = useState('mg');
  const [customRoute, setCustomRoute] = useState<DraftOrderInput['route']>('oral');
  const [customFreq, setCustomFreq] = useState('OD');
  const [customTimes, setCustomTimes] = useState('08:00');
  const [customDays, setCustomDays] = useState(3);
  const [customInstructions, setCustomInstructions] = useState('');

  if (!isOpen) return null;

  const handleAddPreset = (preset: typeof COMMON_IPD_PRESETS[0]) => {
    // Check if already added
    const exists = stagedOrders.some(
      (o) => o.medicineName.toLowerCase() === preset.order.medicineName.toLowerCase(),
    );
    if (exists) {
      setErrorMsg(`"${preset.order.medicineName}" is already in the treatment plan.`);
      return;
    }
    setErrorMsg(null);
    setStagedOrders((prev) => [...prev, { ...preset.order }]);
  };

  const handleFreqChange = (freq: string) => {
    setCustomFreq(freq);
    const config = FREQ_PRESETS[freq];
    if (config) {
      setCustomTimes(config.times.join(', '));
      setCustomDays(config.defaultDays);
    }
  };

  const handleAddCustomOrder = () => {
    if (!customMedName.trim()) {
      setErrorMsg('Please enter a medicine name.');
      return;
    }

    const freqConfig = FREQ_PRESETS[customFreq];
    const isPrn = customFreq === 'PRN';
    const scheduleTimes = isPrn
      ? []
      : customTimes
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);

    const newOrder: DraftOrderInput = {
      medicineId: '',
      medicineName: customMedName.trim(),
      doseAmount: customDose.trim() || '1',
      doseUnit: customUnit.trim() || 'mg',
      route: customRoute,
      frequencyCode: customFreq,
      scheduleTimes,
      scheduleType: isPrn ? 'prn' : 'scheduled',
      isPrn,
      prnIndication: isPrn ? customInstructions || 'When required (SOS)' : undefined,
      durationDays: customDays || 3,
      specialInstructions: customInstructions.trim() || undefined,
    };

    setStagedOrders((prev) => [...prev, newOrder]);
    setCustomMedName('');
    setCustomDose('');
    setCustomInstructions('');
    setErrorMsg(null);
  };

  const handleRemoveOrder = (index: number) => {
    setStagedOrders((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    if (stagedOrders.length === 0) {
      setErrorMsg('Please add at least one prescription or medicine to start the treatment plan.');
      return;
    }

    setErrorMsg(null);
    startTransition(async () => {
      try {
        await createTreatmentPlanAction({
          admissionId,
          diagnosis: diagnosis.trim() || undefined,
          notes: planNotes.trim() || undefined,
          newOrders: stagedOrders,
          doctorId,
          allergyOverrideReason: allergyOverrideReason.trim() || undefined,
          duplicateOverrideReason: duplicateOverrideReason.trim() || undefined,
        });
        onClose();
        router?.refresh();
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to create treatment plan. Please verify practitioner permissions.');
      }
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-ink-950/60 backdrop-blur-xs overflow-y-auto">
      <div className="bg-surface rounded-xl border border-ink-200 shadow-2xl w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden my-auto animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="px-5 py-3.5 bg-ink-50/80 border-b border-ink-200 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-ink-950">
                Create IPD Treatment Plan &amp; Prescriptions
              </h2>
              <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-primary/10 text-primary">
                {patientName}
              </span>
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Set up initial disease management, IV hydration, and medications before nurses begin bedside administration.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-ink-400 hover:text-ink-700 rounded-md hover:bg-ink-100 transition-colors"
            aria-label="Close"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1 text-xs">
          {errorMsg && (
            <div className="p-3 bg-rose-50 border border-rose-200 text-rose-900 rounded-lg text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-semibold">⚠️ {errorMsg}</span>
                <button
                  type="button"
                  onClick={() => setErrorMsg(null)}
                  className="text-rose-600 hover:text-rose-900 font-bold ml-2"
                >
                  ✕
                </button>
              </div>
              {errorMsg.toLowerCase().includes('allergy') && (
                <div className="pt-2 border-t border-rose-200">
                  <label className="block text-2xs font-bold text-rose-950 uppercase mb-1">
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
                  <label className="block text-2xs font-bold text-rose-950 uppercase mb-1">
                    Document Duplicate Therapy Override Reason (mandatory, min 5 chars):
                  </label>
                  <input
                    type="text"
                    value={duplicateOverrideReason}
                    onChange={(e) => setDuplicateOverrideReason(e.target.value)}
                    placeholder="e.g. Step-down crossover / intentional dual antibiotic coverage"
                    className="w-full rounded border border-rose-300 bg-white p-2 text-xs text-ink-900 focus:outline-rose-500"
                  />
                </div>
              )}
            </div>
          )}

          {/* 1. Working Diagnosis & Treatment Strategy */}
          <div className="bg-slate-50/70 p-3 rounded-lg border border-ink-200 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-2xs font-bold text-ink-800 uppercase tracking-wider mb-1">
                  Working Diagnosis / Disease Condition
                </label>
                <input
                  type="text"
                  value={diagnosis}
                  onChange={(e) => setDiagnosis(e.target.value)}
                  placeholder="e.g. Acute Gastroenteritis with dehydration, Type 2 DM"
                  className="w-full px-2.5 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="block text-2xs font-bold text-ink-800 uppercase tracking-wider mb-1">
                  Treatment Strategy / Clinical Notes
                </label>
                <input
                  type="text"
                  value={planNotes}
                  onChange={(e) => setPlanNotes(e.target.value)}
                  placeholder="e.g. IV fluid rehydration protocol, antiemetic SOS, start empirical antibiotics"
                  className="w-full px-2.5 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
            </div>
          </div>

          {/* 2. 1-Click Common IPD Presets */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-2xs font-bold text-ink-700 uppercase tracking-wider">
                1-Click Common IPD Presets
              </span>
              <span className="text-2xs text-ink-400">Click to instantly add to plan</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {COMMON_IPD_PRESETS.map((preset) => {
                const isSelected = stagedOrders.some(
                  (o) => o.medicineName.toLowerCase() === preset.order.medicineName.toLowerCase(),
                );
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => handleAddPreset(preset)}
                    disabled={isSelected}
                    className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-2xs font-medium border transition-colors ${
                      isSelected
                        ? 'bg-emerald-50 border-emerald-300 text-emerald-800 opacity-60 cursor-not-allowed'
                        : 'bg-white border-ink-200 text-ink-800 hover:bg-slate-50 hover:border-primary shadow-2xs'
                    }`}
                  >
                    <span>{isSelected ? '✓' : '+'}</span>
                    <span className="font-semibold">{preset.label}</span>
                    <span className="text-ink-400">({preset.category})</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* 3. Custom Medicine Entry */}
          <div className="p-3 bg-white rounded-lg border border-ink-200 shadow-2xs space-y-2.5">
            <div className="font-bold text-2xs text-ink-800 uppercase tracking-wider">
              Add Specific Medicine / Prescription
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
              <div className="sm:col-span-4">
                <input
                  type="text"
                  value={customMedName}
                  onChange={(e) => setCustomMedName(e.target.value)}
                  placeholder="Medicine name (e.g. Augmentin 625mg, RL, PCM)"
                  className="w-full px-2.5 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="sm:col-span-2 flex gap-1">
                <input
                  type="text"
                  value={customDose}
                  onChange={(e) => setCustomDose(e.target.value)}
                  placeholder="Dose (1)"
                  className="w-16 px-2 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-primary"
                />
                <select
                  value={customUnit}
                  onChange={(e) => setCustomUnit(e.target.value)}
                  className="flex-1 px-1.5 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="mg">mg</option>
                  <option value="g">g</option>
                  <option value="ml">ml</option>
                  <option value="tab">tab</option>
                  <option value="cap">cap</option>
                  <option value="drops">drops</option>
                  <option value="puff">puff</option>
                </select>
              </div>
              <div className="sm:col-span-3">
                <select
                  value={customRoute}
                  onChange={(e) => setCustomRoute(e.target.value as DraftOrderInput['route'])}
                  className="w-full px-2 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  {ROUTE_OPTIONS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="sm:col-span-3">
                <select
                  value={customFreq}
                  onChange={(e) => handleFreqChange(e.target.value)}
                  className="w-full px-2 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 focus:outline-none focus:ring-1 focus:ring-primary"
                >
                  <option value="OD">OD (Once daily - 08:00)</option>
                  <option value="BD">BD (Twice daily - 08:00, 20:00)</option>
                  <option value="TDS">TDS (Thrice daily - 08:00, 14:00, 20:00)</option>
                  <option value="QID">QID (4 times daily)</option>
                  <option value="STAT">STAT (Immediately / Once)</option>
                  <option value="PRN">PRN / SOS (When required)</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center">
              <div className="sm:col-span-4">
                <input
                  type="text"
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  placeholder="Special instructions (e.g. Before food, slow IV)"
                  className="w-full px-2.5 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="sm:col-span-3">
                <input
                  type="text"
                  value={customTimes}
                  onChange={(e) => setCustomTimes(e.target.value)}
                  placeholder="Times: 08:00, 20:00"
                  className="w-full px-2.5 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 placeholder:text-ink-400 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="sm:col-span-2 flex items-center gap-1">
                <span className="text-2xs text-ink-500">Days:</span>
                <input
                  type="number"
                  min={1}
                  max={30}
                  value={customDays}
                  onChange={(e) => setCustomDays(parseInt(e.target.value, 10) || 1)}
                  className="w-14 px-2 py-1.5 rounded border border-ink-200 bg-white text-xs text-ink-900 focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <div className="sm:col-span-3 flex justify-end">
                <button
                  type="button"
                  onClick={handleAddCustomOrder}
                  className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-ink-800 text-white font-semibold hover:bg-ink-950 transition-colors shadow-2xs"
                >
                  <PlusIcon className="size-3.5" />
                  <span>Add to Plan</span>
                </button>
              </div>
            </div>
          </div>

          {/* 4. Current Prescriptions in Treatment Plan */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-2xs font-bold text-ink-800 uppercase tracking-wider">
                Prescriptions in this Treatment Plan ({stagedOrders.length})
              </span>
              {stagedOrders.length > 0 && (
                <button
                  type="button"
                  onClick={() => setStagedOrders([])}
                  className="text-2xs text-rose-600 hover:underline"
                >
                  Clear all
                </button>
              )}
            </div>

            {stagedOrders.length === 0 ? (
              <div className="p-4 rounded-lg border border-dashed border-ink-200 text-center text-ink-500 bg-ink-50/40">
                No medications added yet. Click one of the 1-Click Presets above or enter a custom prescription.
              </div>
            ) : (
              <div className="border border-ink-200 rounded-lg overflow-hidden divide-y divide-ink-100 bg-white">
                {stagedOrders.map((order, idx) => (
                  <div
                    key={idx}
                    className="p-2.5 flex items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
                  >
                    <div className="space-y-0.5">
                      <div className="font-semibold text-ink-900 flex items-center gap-2">
                        <span>{order.medicineName}</span>
                        <span className="text-2xs font-bold px-1.5 py-0.2 rounded bg-ink-100 text-ink-700 uppercase">
                          {order.route}
                        </span>
                        <span className="text-2xs font-bold px-1.5 py-0.2 rounded bg-sky-50 text-sky-800">
                          {order.frequencyCode}
                        </span>
                      </div>
                      <div className="text-2xs text-ink-500 flex items-center gap-2">
                        <span>
                          Dose: {order.doseAmount} {order.doseUnit}
                        </span>
                        <span>•</span>
                        <span>
                          {order.isPrn
                            ? `PRN (${order.prnIndication || 'SOS'})`
                            : `Times: ${order.scheduleTimes?.join(', ') || '08:00'}`}
                        </span>
                        <span>•</span>
                        <span>{order.durationDays} days</span>
                        {order.specialInstructions && (
                          <>
                            <span>•</span>
                            <span className="italic text-ink-600">{order.specialInstructions}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => handleRemoveOrder(idx)}
                      className="text-ink-400 hover:text-rose-600 p-1 rounded hover:bg-rose-50 transition-colors"
                      title="Remove from plan"
                    >
                      <XIcon className="size-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 bg-ink-50/80 border-t border-ink-200 flex items-center justify-between">
          <span className="text-2xs text-ink-500">
            Once saved, nurses immediately receive these on bedside eMAR with today's dose checkboxes.
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={isPending}
              onClick={onClose}
              className="px-3 py-1.5 rounded border border-ink-200 text-ink-700 hover:bg-ink-100 font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={isPending || stagedOrders.length === 0}
              onClick={handleSubmit}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CheckIcon className="size-4" />
              <span>{isPending ? 'Saving Treatment Plan...' : 'Save & Start Treatment Plan'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
