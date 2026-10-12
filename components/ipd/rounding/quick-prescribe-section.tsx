'use client';

import { useState } from 'react';
import { Button, cn } from '@/components/ui';
import type { AllergenItem } from '@/lib/services/ipd-rounding-cockpit';
import type { DraftOrderInput } from '@/lib/services/ipd-medication-orders';

export interface QuickPrescribeSectionProps {
  frequentMedicines: Array<{
    id: string;
    name: string;
    genericName: string | null;
    form: string | null;
    unit: string;
  }>;
  newOrders: DraftOrderInput[];
  onAddNewOrder: (order: DraftOrderInput) => void;
  onRemoveNewOrder: (index: number) => void;
  activeAllergies?: AllergenItem[];
  className?: string;
}

const COMMON_PRESETS = [
  {
    medicineName: 'Pantoprazole 40mg IV',
    doseAmount: '40',
    doseUnit: 'mg',
    route: 'iv_push' as const,
    frequencyCode: 'OD',
    scheduleTimes: ['08:00'],
    scheduleType: 'scheduled' as const,
    durationDays: 3,
    specialInstructions: 'Give before breakfast',
  },
  {
    medicineName: 'Paracetamol 650mg Oral',
    doseAmount: '650',
    doseUnit: 'mg',
    route: 'oral' as const,
    frequencyCode: 'PRN',
    scheduleType: 'prn' as const,
    isPrn: true,
    prnIndication: 'For fever > 100°F or moderate pain',
    prnMinIntervalHours: 6,
    prnMaxDailyDoses: 4,
    durationDays: 3,
  },
  {
    medicineName: 'Ondansetron 4mg IV',
    doseAmount: '4',
    doseUnit: 'mg',
    route: 'iv_push' as const,
    frequencyCode: 'PRN',
    scheduleType: 'prn' as const,
    isPrn: true,
    prnIndication: 'For nausea or vomiting (SOS)',
    prnMinIntervalHours: 8,
    prnMaxDailyDoses: 3,
    durationDays: 3,
  },
  {
    medicineName: 'Ceftriaxone 1g IV',
    doseAmount: '1',
    doseUnit: 'g',
    route: 'iv_push' as const,
    frequencyCode: 'BD',
    scheduleTimes: ['08:00', '20:00'],
    scheduleType: 'scheduled' as const,
    durationDays: 5,
    specialInstructions: 'Slow IV injection over 5 minutes',
  },
  {
    medicineName: 'Tramadol 50mg IV',
    doseAmount: '50',
    doseUnit: 'mg',
    route: 'iv_push' as const,
    frequencyCode: 'PRN',
    scheduleType: 'prn' as const,
    isPrn: true,
    prnIndication: 'For severe breakthrough pain',
    prnMinIntervalHours: 8,
    prnMaxDailyDoses: 2,
    durationDays: 2,
  },
];

const ROUTE_OPTIONS: Array<{ id: DraftOrderInput['route']; label: string }> = [
  { id: 'oral', label: 'Oral (PO)' },
  { id: 'iv_push', label: 'IV Push' },
  { id: 'iv_piggyback', label: 'IV Piggyback' },
  { id: 'im', label: 'Intramuscular (IM)' },
  { id: 'sc', label: 'Subcutaneous (SC)' },
  { id: 'nebulization', label: 'Nebulization' },
  { id: 'sublingual', label: 'Sublingual' },
  { id: 'topical', label: 'Topical' },
  { id: 'inhalation', label: 'Inhalation' },
];

const FREQ_OPTIONS: Record<string, { label: string; times: string[]; defaultDays: number }> = {
  OD: { label: 'OD (Once daily)', times: ['08:00'], defaultDays: 3 },
  BD: { label: 'BD (Twice daily)', times: ['08:00', '20:00'], defaultDays: 3 },
  TDS: { label: 'TDS (3x daily)', times: ['08:00', '14:00', '20:00'], defaultDays: 3 },
  QID: { label: 'QID (4x daily)', times: ['06:00', '12:00', '18:00', '22:00'], defaultDays: 2 },
  Stat: { label: 'Stat (Immediate once)', times: ['Immediate'], defaultDays: 1 },
  PRN: { label: 'PRN (As needed / SOS)', times: [], defaultDays: 3 },
};

export function QuickPrescribeSection({
  frequentMedicines,
  newOrders,
  onAddNewOrder,
  onRemoveNewOrder,
  activeAllergies = [],
  className,
}: QuickPrescribeSectionProps) {
  // Builder state
  const [isBuilderOpen, setIsBuilderOpen] = useState(false);
  const [medicineId, setMedicineId] = useState<string>('');
  const [medicineName, setMedicineName] = useState<string>('');
  const [doseAmount, setDoseAmount] = useState<string>('1');
  const [doseUnit, setDoseUnit] = useState<string>('tab');
  const [route, setRoute] = useState<DraftOrderInput['route']>('oral');
  const [frequencyCode, setFrequencyCode] = useState<string>('OD');
  const [scheduleType, setScheduleType] = useState<'scheduled' | 'prn' | 'stat'>('scheduled');
  const [durationDays, setDurationDays] = useState<number>(3);
  const [prnIndication, setPrnIndication] = useState<string>('');
  const [prnMinIntervalHours, setPrnMinIntervalHours] = useState<number>(6);
  const [prnMaxDailyDoses, setPrnMaxDailyDoses] = useState<number>(4);
  const [specialInstructions, setSpecialInstructions] = useState<string>('');
  const [validationError, setValidationError] = useState<string | null>(null);

  // Check for allergy match against entered drug name
  const allergyWarning = activeAllergies.find((allergy) => {
    if (!medicineName.trim()) return false;
    const medLower = medicineName.toLowerCase();
    const substanceLower = allergy.substance.toLowerCase();
    return medLower.includes(substanceLower) || substanceLower.includes(medLower);
  });

  const applyPreset = (preset: typeof COMMON_PRESETS[0]) => {
    setMedicineId(`preset-${preset.medicineName}`);
    setMedicineName(preset.medicineName);
    setDoseAmount(preset.doseAmount);
    setDoseUnit(preset.doseUnit);
    setRoute(preset.route);
    setFrequencyCode(preset.frequencyCode);
    setScheduleType(preset.scheduleType);
    setDurationDays(preset.durationDays);
    setPrnIndication(preset.prnIndication || '');
    setPrnMinIntervalHours(preset.prnMinIntervalHours || 6);
    setPrnMaxDailyDoses(preset.prnMaxDailyDoses || 4);
    setSpecialInstructions(preset.specialInstructions || '');
    setValidationError(null);
    setIsBuilderOpen(true);
  };

  const handleFrequencyChange = (code: string) => {
    setFrequencyCode(code);
    if (code === 'PRN') {
      setScheduleType('prn');
      if (!prnIndication) setPrnIndication('As needed for symptoms');
    } else if (code === 'Stat') {
      setScheduleType('stat');
      setDurationDays(1);
    } else {
      setScheduleType('scheduled');
      const opt = FREQ_OPTIONS[code];
      if (opt) setDurationDays(opt.defaultDays);
    }
  };

  const handleAddOrder = () => {
    setValidationError(null);
    const trimmedName = medicineName.trim();
    if (!trimmedName) {
      setValidationError('Please specify the medication name.');
      return;
    }
    const trimmedDose = doseAmount.trim();
    if (!trimmedDose || isNaN(Number(trimmedDose)) || Number(trimmedDose) <= 0) {
      setValidationError('Please specify a valid positive dose amount.');
      return;
    }
    if (!doseUnit.trim()) {
      setValidationError('Please specify a dose unit (e.g. mg, g, ml, tab).');
      return;
    }

    if (frequencyCode === 'PRN' && !prnIndication.trim()) {
      setValidationError('PRN / SOS orders require a documented indication (e.g. fever > 100°F).');
      return;
    }

    const freqDef = FREQ_OPTIONS[frequencyCode];
    const scheduleTimes =
      frequencyCode === 'PRN'
        ? []
        : frequencyCode === 'Stat'
          ? ['Immediate']
          : freqDef?.times || ['08:00'];

    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + durationDays * 86400000);

    const orderPayload: DraftOrderInput = {
      medicineId: medicineId || `custom-${Date.now()}`,
      medicineName: trimmedName,
      doseAmount: trimmedDose,
      doseUnit: doseUnit.trim(),
      route,
      scheduleType,
      frequencyCode,
      scheduleTimes,
      isPrn: frequencyCode === 'PRN',
      prnIndication: frequencyCode === 'PRN' ? prnIndication.trim() : null,
      prnMinIntervalHours: frequencyCode === 'PRN' ? prnMinIntervalHours : null,
      prnMaxDailyDoses: frequencyCode === 'PRN' ? prnMaxDailyDoses : null,
      specialInstructions: specialInstructions.trim() || null,
      startsAt,
      endsAt,
      durationDays,
    };

    onAddNewOrder(orderPayload);

    // Reset form
    setMedicineId('');
    setMedicineName('');
    setDoseAmount('1');
    setDoseUnit('tab');
    setRoute('oral');
    setFrequencyCode('OD');
    setScheduleType('scheduled');
    setDurationDays(3);
    setPrnIndication('');
    setSpecialInstructions('');
    setIsBuilderOpen(false);
  };

  return (
    <div className={cn('space-y-4 rounded-xl border border-ink-200 bg-white p-4 shadow-xs', className)}>
      {/* Title & Quick Prescribe Preset Chips */}
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-ink-900">
              Inpatient Prescribing
            </h3>
            <p className="text-xs text-ink-500">
              Tap a frequent ward medication or build a new inpatient prescription order.
            </p>
          </div>

          {!isBuilderOpen && (
            <button
              type="button"
              onClick={() => setIsBuilderOpen(true)}
              className="inline-flex items-center gap-1 rounded-lg border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs font-semibold text-brand-700 shadow-xs hover:bg-brand-100"
            >
              + Add Custom Prescription
            </button>
          )}
        </div>

        {/* Rapid Preset Chips */}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <span className="self-center text-[11px] font-semibold uppercase tracking-wider text-ink-400">
            Quick:
          </span>
          {COMMON_PRESETS.map((preset) => (
            <button
              key={preset.medicineName}
              type="button"
              onClick={() => applyPreset(preset)}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-800 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-900"
            >
              <span>+ {preset.medicineName}</span>
              <span className="text-[10px] text-ink-500 font-normal">({preset.frequencyCode})</span>
            </button>
          ))}
          {frequentMedicines.slice(0, 3).map((fm) => (
            <button
              key={fm.id}
              type="button"
              onClick={() => {
                setMedicineId(fm.id);
                setMedicineName(fm.name);
                setDoseUnit(fm.unit || 'tab');
                setIsBuilderOpen(true);
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-ink-200 bg-ink-50 px-2.5 py-1 text-xs font-medium text-ink-700 hover:border-brand-300 hover:bg-brand-50"
            >
              <span>+ {fm.name}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Interactive Prescription Builder Drawer/Form */}
      {isBuilderOpen && (
        <div className="rounded-xl border border-brand-200 bg-brand-50/20 p-4 space-y-3">
          <div className="flex items-center justify-between border-b border-brand-100 pb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-brand-900">
              New Inpatient Medication Order
            </span>
            <button
              type="button"
              onClick={() => setIsBuilderOpen(false)}
              className="rounded p-1 text-ink-400 hover:text-ink-600"
            >
              ✕ Cancel
            </button>
          </div>

          {validationError && (
            <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-800">
              {validationError}
            </div>
          )}

          {allergyWarning && (
            <div className="rounded-lg border-2 border-rose-500 bg-rose-50 p-2.5 text-xs text-rose-900 flex items-center gap-2">
              <span className="text-sm font-bold">⚠️</span>
              <div>
                <strong className="font-semibold">Patient Allergy Alert:</strong> Documented reaction to{' '}
                <span className="underline font-bold">{allergyWarning.substance}</span> (
                {allergyWarning.severity} - {allergyWarning.reaction || 'no reaction noted'}).
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            {/* Drug Name */}
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-ink-700">
                Medication Name <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={medicineName}
                onChange={(e) => setMedicineName(e.target.value)}
                placeholder="e.g. Amoxicillin-Clavulanate 625mg"
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {/* Dose Amount */}
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Dose Amount <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={doseAmount}
                onChange={(e) => setDoseAmount(e.target.value)}
                placeholder="e.g. 1, 500, 40"
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>

            {/* Dose Unit */}
            <div>
              <label className="block text-xs font-medium text-ink-700">
                Unit <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                value={doseUnit}
                onChange={(e) => setDoseUnit(e.target.value)}
                placeholder="mg, g, ml, tab, amp"
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {/* Route */}
            <div>
              <label className="block text-xs font-medium text-ink-700">Route</label>
              <select
                value={route}
                onChange={(e) => setRoute(e.target.value as DraftOrderInput['route'])}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {ROUTE_OPTIONS.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Frequency */}
            <div>
              <label className="block text-xs font-medium text-ink-700">Frequency</label>
              <select
                value={frequencyCode}
                onChange={(e) => handleFrequencyChange(e.target.value)}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              >
                {Object.entries(FREQ_OPTIONS).map(([code, opt]) => (
                  <option key={code} value={code}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>

            {/* Duration Days */}
            <div>
              <label className="block text-xs font-medium text-ink-700">Duration (Days)</label>
              <input
                type="number"
                min="1"
                max="30"
                value={durationDays}
                onChange={(e) => setDurationDays(Math.max(1, parseInt(e.target.value, 10) || 1))}
                className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>

          {/* PRN Details if selected */}
          {frequencyCode === 'PRN' && (
            <div className="grid grid-cols-1 gap-3 rounded-lg border border-amber-200 bg-amber-50/50 p-3 sm:grid-cols-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-amber-900">
                  PRN Indication (Reason) <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={prnIndication}
                  onChange={(e) => setPrnIndication(e.target.value)}
                  placeholder="e.g. For temperature > 100°F, For breakthrough pain"
                  className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-xs text-amber-950 focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="block text-xs font-medium text-amber-900">Min Gap (Hrs)</label>
                  <input
                    type="number"
                    min="1"
                    max="24"
                    value={prnMinIntervalHours}
                    onChange={(e) => setPrnMinIntervalHours(parseInt(e.target.value, 10) || 4)}
                    className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs text-amber-950"
                  />
                </div>
                <div className="flex-1">
                  <label className="block text-xs font-medium text-amber-900">Max/Day</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={prnMaxDailyDoses}
                    onChange={(e) => setPrnMaxDailyDoses(parseInt(e.target.value, 10) || 3)}
                    className="mt-1 w-full rounded-lg border border-amber-300 bg-white px-2 py-1.5 text-xs text-amber-950"
                  />
                </div>
              </div>
            </div>
          )}

          {/* Special Instructions */}
          <div>
            <label className="block text-xs font-medium text-ink-700">Special Instructions / Admin Notes</label>
            <input
              type="text"
              value={specialInstructions}
              onChange={(e) => setSpecialInstructions(e.target.value)}
              placeholder="e.g. With milk, Slow IV push, Do not crush"
              className="mt-1 w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => setIsBuilderOpen(false)}
              className="rounded-lg border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-700 hover:bg-ink-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAddOrder}
              className="rounded-lg bg-brand-600 px-4 py-1.5 text-xs font-semibold text-white shadow-xs hover:bg-brand-700"
            >
              Add to Prescription List
            </button>
          </div>
        </div>
      )}

      {/* Staged New Orders List */}
      {newOrders.length > 0 && (
        <div className="space-y-2 border-t border-ink-100 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-emerald-800">
              New Orders to Authorize ({newOrders.length})
            </span>
            <span className="text-[11px] text-ink-500">
              Will become active upon signing round note
            </span>
          </div>

          <div className="space-y-1.5">
            {newOrders.map((ord, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between rounded-lg border border-emerald-200 bg-emerald-50/60 p-2.5 text-xs text-emerald-950 shadow-xs"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-emerald-900">{ord.medicineName}</span>
                    <span className="rounded bg-emerald-100 px-1.5 py-0.2 font-mono text-[10px] font-semibold text-emerald-800">
                      {ord.doseAmount} {ord.doseUnit}
                    </span>
                    <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-medium uppercase text-emerald-800">
                      {ord.route.replace('_', ' ')}
                    </span>
                    <span className="rounded bg-emerald-100 px-1.5 py-0.2 text-[10px] font-bold text-emerald-900">
                      {ord.frequencyCode}
                    </span>
                  </div>
                  <div className="text-[11px] text-emerald-800 flex gap-3">
                    <span>Duration: {ord.durationDays} days</span>
                    {ord.isPrn && <span>Indication: {ord.prnIndication}</span>}
                    {ord.specialInstructions && <span>Note: {ord.specialInstructions}</span>}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => onRemoveNewOrder(idx)}
                  className="rounded p-1 text-emerald-700 hover:bg-emerald-100 hover:text-rose-600"
                  title="Remove from staged orders"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
