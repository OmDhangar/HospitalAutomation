'use client';

import React, { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  saveDischargeSummaryAction,
  finalizeDischargeSummaryAction,
  reconcileHomeMedicationAction,
} from '@/app/(app)/ipd/actions';
import { Drawer } from '@/components/ipd/drawer';
import { Button } from '@/components/ui';
import { PrinterIcon, PlusIcon, CheckIcon } from '@/components/icons';

export interface TakeHomeMedItem {
  medicineName: string;
  dosage: string;
  route: string;
  frequency: string;
  duration: string;
  instructions: string;
}

export interface HomeMedReconItem {
  id?: string;
  medicineName: string;
  dosage: string;
  frequency: string;
  reconciliationStatus: 'continued' | 'stopped' | 'modified';
  reconciliationNotes?: string;
}

export interface DischargeSummaryDrawerProps {
  admissionId: string;
  isOpen: boolean;
  onClose: () => void;
  patientName: string;
  initialSummary?: {
    id?: string;
    version?: number;
    dischargeType?: 'regular' | 'lama' | 'dama' | 'transfer' | 'death';
    status?: 'draft' | 'finalized';
    primaryDiagnosis?: string | null;
    secondaryDiagnoses?: string | null;
    hospitalCourse?: string | null;
    conditionAtDischarge?: string | null;
    investigationSummary?: string | null;
    dischargeAdvice?: string | null;
    dietAdvice?: string | null;
    urgentWarningSigns?: string | null;
    followUpDate?: string | null;
    prescriberDoctorId?: string | null;
    prescriberRegistrationNo?: string | null;
    finalizedAt?: string | Date | null;
    takeHomePrescriptions?: TakeHomeMedItem[];
  } | null;
  homeMedications?: HomeMedReconItem[];
  attendingDoctor?: {
    id: string;
    name: string;
    registrationNo?: string | null;
  } | null;
}

export function DischargeSummaryDrawer({
  admissionId,
  isOpen,
  onClose,
  patientName,
  initialSummary,
  homeMedications = [],
  attendingDoctor,
}: DischargeSummaryDrawerProps) {
  let router: { refresh: () => void } | null = null;
  try {
    router = useRouter();
  } catch {
    router = null;
  }

  const [isPending, startTransition] = useTransition();
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Form State
  const [dischargeType, setDischargeType] = useState<'regular' | 'lama' | 'dama' | 'transfer' | 'death'>(
    initialSummary?.dischargeType ?? 'regular',
  );
  const [primaryDiagnosis, setPrimaryDiagnosis] = useState(initialSummary?.primaryDiagnosis ?? '');
  const [secondaryDiagnoses, setSecondaryDiagnoses] = useState(initialSummary?.secondaryDiagnoses ?? '');
  const [hospitalCourse, setHospitalCourse] = useState(initialSummary?.hospitalCourse ?? '');
  const [conditionAtDischarge, setConditionAtDischarge] = useState(initialSummary?.conditionAtDischarge ?? '');
  const [investigationSummary, setInvestigationSummary] = useState(initialSummary?.investigationSummary ?? '');
  const [dischargeAdvice, setDischargeAdvice] = useState(initialSummary?.dischargeAdvice ?? '');
  const [dietAdvice, setDietAdvice] = useState(initialSummary?.dietAdvice ?? '');
  const [urgentWarningSigns, setUrgentWarningSigns] = useState(initialSummary?.urgentWarningSigns ?? '');
  const [followUpDate, setFollowUpDate] = useState(initialSummary?.followUpDate ?? '');

  // Structured Take-Home Drugs
  const [takeHomeMeds, setTakeHomeMeds] = useState<TakeHomeMedItem[]>(
    initialSummary?.takeHomePrescriptions ?? [
      {
        medicineName: 'Paracetamol 650mg',
        dosage: '650mg',
        route: 'oral',
        frequency: 'PRN',
        duration: '5 days',
        instructions: 'Take 1 tablet SOS after meals for fever/pain',
      },
      {
        medicineName: 'Pantoprazole 40mg',
        dosage: '40mg',
        route: 'oral',
        frequency: 'OD',
        duration: '5 days',
        instructions: 'Take 1 tablet early morning before breakfast',
      },
    ],
  );

  const [newMedName, setNewMedName] = useState('');
  const [newMedDose, setNewMedDose] = useState('');
  const [newMedFreq, setNewMedFreq] = useState('OD');
  const [newMedDuration, setNewMedDuration] = useState('5 days');
  const [newMedInstructions, setNewMedInstructions] = useState('');

  // New Home Med reconciliation input
  const [newHomeMedName, setNewHomeMedName] = useState('');
  const [newHomeMedDose, setNewHomeMedDose] = useState('');
  const [newHomeMedStatus, setNewHomeMedStatus] = useState<'continued' | 'stopped' | 'modified'>('continued');

  const isFinalized = initialSummary?.status === 'finalized';

  const handleAddTakeHomeMed = () => {
    if (!newMedName.trim()) return;
    setTakeHomeMeds((prev) => [
      ...prev,
      {
        medicineName: newMedName.trim(),
        dosage: newMedDose.trim() || '1 tab',
        route: 'oral',
        frequency: newMedFreq,
        duration: newMedDuration.trim() || '5 days',
        instructions: newMedInstructions.trim(),
      },
    ]);
    setNewMedName('');
    setNewMedDose('');
    setNewMedInstructions('');
  };

  const handleRemoveTakeHomeMed = (idx: number) => {
    setTakeHomeMeds((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleAddHomeMed = () => {
    if (!newHomeMedName.trim()) return;
    startTransition(async () => {
      try {
        await reconcileHomeMedicationAction({
          admissionId,
          medicineName: newHomeMedName.trim(),
          dosage: newHomeMedDose.trim() || undefined,
          reconciliationStatus: newHomeMedStatus,
        });
        setNewHomeMedName('');
        setNewHomeMedDose('');
        router?.refresh();
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to record home medication');
      }
    });
  };

  const handleSaveDraft = () => {
    setErrorMsg(null);
    setSuccessMsg(null);
    startTransition(async () => {
      try {
        const res = await saveDischargeSummaryAction({
          admissionId,
          dischargeType,
          primaryDiagnosis: primaryDiagnosis.trim() || undefined,
          secondaryDiagnoses: secondaryDiagnoses.trim() || undefined,
          hospitalCourse: hospitalCourse.trim() || undefined,
          conditionAtDischarge: conditionAtDischarge.trim() || undefined,
          investigationSummary: investigationSummary.trim() || undefined,
          dischargeAdvice: dischargeAdvice.trim() || undefined,
          dietAdvice: dietAdvice.trim() || undefined,
          urgentWarningSigns: urgentWarningSigns.trim() || undefined,
          followUpDate: followUpDate.trim() || undefined,
          doctorId: attendingDoctor?.id,
          takeHomePrescriptions: takeHomeMeds,
        });

        setSuccessMsg(`Draft saved successfully (Version ${res.version}).`);
        router?.refresh();
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to save discharge summary draft');
      }
    });
  };

  const handleFinalize = () => {
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!primaryDiagnosis.trim()) {
      setErrorMsg('Please specify a primary diagnosis before finalization.');
      return;
    }

    startTransition(async () => {
      try {
        // First ensure draft is saved
        const draftRes = await saveDischargeSummaryAction({
          admissionId,
          dischargeType,
          primaryDiagnosis: primaryDiagnosis.trim() || undefined,
          secondaryDiagnoses: secondaryDiagnoses.trim() || undefined,
          hospitalCourse: hospitalCourse.trim() || undefined,
          conditionAtDischarge: conditionAtDischarge.trim() || undefined,
          investigationSummary: investigationSummary.trim() || undefined,
          dischargeAdvice: dischargeAdvice.trim() || undefined,
          dietAdvice: dietAdvice.trim() || undefined,
          urgentWarningSigns: urgentWarningSigns.trim() || undefined,
          followUpDate: followUpDate.trim() || undefined,
          doctorId: attendingDoctor?.id,
          takeHomePrescriptions: takeHomeMeds,
        });

        // Now finalize
        await finalizeDischargeSummaryAction({
          admissionId,
          summaryId: draftRes.summaryId,
          doctorId: attendingDoctor?.id,
        });

        setSuccessMsg('Discharge summary successfully finalized with doctor registration number.');
        router?.refresh();
      } catch (err: any) {
        setErrorMsg(err?.message || 'Failed to finalize discharge summary.');
      }
    });
  };

  return (
    <Drawer
      isOpen={isOpen}
      onClose={onClose}
      title={`Discharge Summary — ${patientName}`}
      subtitle="Versioned clinical discharge card, structured take-home medications & statutory prescriber co-signature"
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onClose}
            disabled={isPending}
          >
            Close
          </Button>

          <div className="flex items-center gap-2">
            {!isFinalized && (
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleSaveDraft}
                isLoading={isPending}
              >
                Save Draft
              </Button>
            )}

            {!isFinalized ? (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={handleFinalize}
                isLoading={isPending}
                className="bg-emerald-600 hover:bg-emerald-700 font-bold"
              >
                Finalize &amp; Sign Summary
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => window.print()}
                className="gap-1.5"
              >
                <PrinterIcon className="size-3.5" />
                <span>Print Final Summary</span>
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4 text-xs">
        {errorMsg && (
          <div className="rounded-lg border border-rose-300 bg-rose-50 p-3 font-medium text-rose-900">
            ⚠️ {errorMsg}
          </div>
        )}

        {successMsg && (
          <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 font-medium text-emerald-900">
            ✓ {successMsg}
          </div>
        )}

        {/* Finalized Banner */}
        {isFinalized && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-emerald-950 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xl">✅</span>
              <div>
                <div className="font-bold">Finalized Clinical Document</div>
                <div className="text-2xs text-emerald-800">
                  Signed with Doctor Registration #{initialSummary?.prescriberRegistrationNo ?? 'On Record'}
                </div>
              </div>
            </div>
            <span className="rounded bg-emerald-200 px-2 py-0.5 text-2xs font-bold uppercase text-emerald-900">
              v{initialSummary?.version ?? 1} Final
            </span>
          </div>
        )}

        {/* Prescriber Doctor Registration Card */}
        <div className="rounded-xl border border-ink-200 bg-slate-50/70 p-3">
          <div className="flex items-center justify-between">
            <span className="text-2xs font-bold text-ink-600 uppercase tracking-wide">
              Attending Prescriber &amp; Registration
            </span>
            {attendingDoctor?.registrationNo ? (
              <span className="rounded bg-emerald-100 px-2 py-0.5 text-2xs font-bold text-emerald-800 border border-emerald-200">
                Reg: {attendingDoctor.registrationNo}
              </span>
            ) : (
              <span className="rounded bg-rose-100 px-2 py-0.5 text-2xs font-bold text-rose-800 border border-rose-200">
                ⚠️ Registration missing on profile
              </span>
            )}
          </div>
          <div className="mt-1 font-semibold text-ink-950">
            {attendingDoctor?.name ?? 'Attending Consultant'}
          </div>
        </div>

        {/* Discharge Type Selection */}
        <div className="space-y-1">
          <label className="block text-2xs font-bold text-ink-700 uppercase tracking-wide">
            Discharge Type *
          </label>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
            {(['regular', 'lama', 'dama', 'transfer', 'death'] as const).map((type) => (
              <button
                key={type}
                type="button"
                disabled={isFinalized}
                onClick={() => setDischargeType(type)}
                className={`py-1.5 px-2 rounded-lg text-xs font-bold uppercase border transition-colors ${
                  dischargeType === type
                    ? 'border-brand-600 bg-brand-50 text-brand-700'
                    : 'border-ink-200 bg-surface text-ink-700 hover:bg-ink-50'
                }`}
              >
                {type}
              </button>
            ))}
          </div>
        </div>

        {/* Diagnosis & Clinical Course */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
              Primary Diagnosis *
            </label>
            <input
              type="text"
              disabled={isFinalized}
              value={primaryDiagnosis}
              onChange={(e) => setPrimaryDiagnosis(e.target.value)}
              placeholder="e.g. Acute Appendicitis (Post-Lap Appendectomy)"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-brand-500"
            />
          </div>

          <div>
            <label className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
              Secondary / Comorbid Diagnoses
            </label>
            <input
              type="text"
              disabled={isFinalized}
              value={secondaryDiagnoses}
              onChange={(e) => setSecondaryDiagnoses(e.target.value)}
              placeholder="e.g. Type 2 Diabetes Mellitus, Essential HTN"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-brand-500"
            />
          </div>
        </div>

        {/* Hospital Course */}
        <div>
          <label className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
            Hospital Course &amp; Treatment Summary
          </label>
          <textarea
            rows={3}
            disabled={isFinalized}
            value={hospitalCourse}
            onChange={(e) => setHospitalCourse(e.target.value)}
            placeholder="Clinical progression, surgical procedures performed, response to IV therapy..."
            className="w-full rounded-lg border border-ink-300 bg-white p-2.5 text-xs text-ink-900 focus:outline-brand-500"
          />
        </div>

        {/* Condition at Discharge & Urgent Warning Signs */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
              Condition at Discharge
            </label>
            <input
              type="text"
              disabled={isFinalized}
              value={conditionAtDischarge}
              onChange={(e) => setConditionAtDischarge(e.target.value)}
              placeholder="e.g. Clinically stable, wound healthy, afebrile"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-brand-500"
            />
          </div>

          <div>
            <label className="block text-2xs font-bold text-ink-700 uppercase tracking-wide mb-1">
              Follow-Up Date / OPD Review
            </label>
            <input
              type="text"
              disabled={isFinalized}
              value={followUpDate}
              onChange={(e) => setFollowUpDate(e.target.value)}
              placeholder="e.g. After 5 days in Surgical OPD / 2026-10-20"
              className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2 text-xs text-ink-900 focus:outline-brand-500"
            />
          </div>
        </div>

        {/* Structured Take-Home Medications Table */}
        <div className="rounded-xl border border-ink-200 bg-slate-50/50 p-3 space-y-2.5">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-ink-950 uppercase tracking-wide">
              Structured Take-Home Medications ({takeHomeMeds.length})
            </h4>
            <span className="text-2xs text-ink-500">Auto-printed on discharge card</span>
          </div>

          <div className="divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white overflow-hidden">
            {takeHomeMeds.length === 0 ? (
              <div className="p-3 text-center text-xs text-ink-400 italic">
                No take-home medications added yet.
              </div>
            ) : (
              takeHomeMeds.map((med, i) => (
                <div key={i} className="flex items-center justify-between p-2.5 text-xs">
                  <div>
                    <span className="font-bold text-ink-900 mr-2">{med.medicineName}</span>
                    <span className="rounded bg-sky-50 px-1.5 py-0.5 text-2xs font-semibold text-sky-800 mr-1.5">
                      {med.dosage}
                    </span>
                    <span className="rounded bg-ink-100 px-1.5 py-0.5 text-2xs font-medium text-ink-700 mr-1.5">
                      {med.frequency}
                    </span>
                    <span className="text-2xs text-ink-500">({med.duration})</span>
                    {med.instructions && (
                      <div className="text-2xs italic text-ink-600 mt-0.5">
                        {med.instructions}
                      </div>
                    )}
                  </div>
                  {!isFinalized && (
                    <button
                      type="button"
                      onClick={() => handleRemoveTakeHomeMed(i)}
                      className="text-rose-600 hover:text-rose-800 font-bold px-2 py-1 text-xs"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          {!isFinalized && (
            <div className="flex flex-wrap gap-2 pt-1">
              <input
                type="text"
                placeholder="Medicine Name"
                value={newMedName}
                onChange={(e) => setNewMedName(e.target.value)}
                className="flex-1 min-w-[140px] rounded border border-ink-300 px-2 py-1 text-xs"
              />
              <input
                type="text"
                placeholder="Dose"
                value={newMedDose}
                onChange={(e) => setNewMedDose(e.target.value)}
                className="w-20 rounded border border-ink-300 px-2 py-1 text-xs"
              />
              <select
                value={newMedFreq}
                onChange={(e) => setNewMedFreq(e.target.value)}
                className="rounded border border-ink-300 px-2 py-1 text-xs bg-white"
              >
                <option value="OD">OD</option>
                <option value="BD">BD</option>
                <option value="TDS">TDS</option>
                <option value="QID">QID</option>
                <option value="PRN">PRN (SOS)</option>
              </select>
              <input
                type="text"
                placeholder="Days"
                value={newMedDuration}
                onChange={(e) => setNewMedDuration(e.target.value)}
                className="w-20 rounded border border-ink-300 px-2 py-1 text-xs"
              />
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleAddTakeHomeMed}
                className="text-xs font-semibold"
              >
                + Add Drug
              </Button>
            </div>
          )}
        </div>

        {/* Admission Home Medication Reconciliation */}
        <div className="rounded-xl border border-ink-200 bg-slate-50/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <h4 className="text-xs font-bold text-ink-950 uppercase tracking-wide">
              Admission Home Medication Reconciliation
            </h4>
            <span className="text-2xs text-ink-500">NABH Inpatient Medication Safety</span>
          </div>

          {homeMedications.length > 0 && (
            <div className="divide-y divide-ink-100 rounded-lg border border-ink-200 bg-white overflow-hidden">
              {homeMedications.map((hm, idx) => (
                <div key={idx} className="flex items-center justify-between p-2 text-xs">
                  <div>
                    <span className="font-semibold text-ink-900 mr-2">{hm.medicineName}</span>
                    <span className="text-2xs text-ink-500">{hm.dosage} · {hm.frequency}</span>
                  </div>
                  <span
                    className={`rounded px-1.5 py-0.5 text-2xs font-bold uppercase ${
                      hm.reconciliationStatus === 'continued'
                        ? 'bg-emerald-100 text-emerald-800'
                        : hm.reconciliationStatus === 'stopped'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-amber-100 text-amber-800'
                    }`}
                  >
                    {hm.reconciliationStatus}
                  </span>
                </div>
              ))}
            </div>
          )}

          {!isFinalized && (
            <div className="flex flex-wrap gap-2 pt-1">
              <input
                type="text"
                placeholder="Home Drug (e.g. Metformin 500mg)"
                value={newHomeMedName}
                onChange={(e) => setNewHomeMedName(e.target.value)}
                className="flex-1 min-w-[140px] rounded border border-ink-300 px-2 py-1 text-xs"
              />
              <input
                type="text"
                placeholder="Dose"
                value={newHomeMedDose}
                onChange={(e) => setNewHomeMedDose(e.target.value)}
                className="w-20 rounded border border-ink-300 px-2 py-1 text-xs"
              />
              <select
                value={newHomeMedStatus}
                onChange={(e) => setNewHomeMedStatus(e.target.value as any)}
                className="rounded border border-ink-300 px-2 py-1 text-xs bg-white"
              >
                <option value="continued">Continued</option>
                <option value="stopped">Stopped</option>
                <option value="modified">Modified</option>
              </select>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleAddHomeMed}
                className="text-xs"
              >
                Reconcile
              </Button>
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
}
