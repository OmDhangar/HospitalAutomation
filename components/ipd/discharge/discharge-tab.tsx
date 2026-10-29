'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { DischargeSummaryDrawer } from './discharge-summary-drawer';
import { MedicalClearanceModal } from './drawers/medical-clearance-modal';
import { PharmacyReturnDrawer } from './drawers/pharmacy-return-drawer';
import { GatePassModal } from './drawers/gate-pass-modal';
import { MedicalClearanceCard } from './cards/medical-clearance-card';
import { PharmacyClearanceCard } from './cards/pharmacy-clearance-card';
import { NursingClearanceCard } from './cards/nursing-clearance-card';
import { SummaryClearanceCard } from './cards/summary-clearance-card';
import { BillingGatePassCard } from './cards/billing-gate-pass-card';
import { PrinterIcon } from '@/components/icons';
import {
  updateMedicalClearanceAction,
  recordPharmacyClearanceAction,
  updateNursingClearanceAction,
  issueDischargeGatePassAction,
} from '@/app/(app)/ipd/actions';
import type { IpdDischargeClearanceRow, PharmacyReturnItem } from '@/lib/db/schema';
import { computeClearanceStatus } from '@/lib/domain/discharge-clearance';

export interface DischargeTabProps {
  admissionId: string;
  status: string;
  canDischarge?: boolean;
  dischargeReadyAt?: string | Date | null;
  onToggleDischargeReady?: (ready: boolean) => Promise<void>;
  doctorName?: string;
  patientName?: string;
  mrn?: string;
  ipdNumber?: string;
  bedLabel?: string;
  wardName?: string;
  dischargeMedicationsCount?: number;
  dischargeSummary?: any;
  homeMedications?: any[];
  attendingDoctor?: any;
  initialClearance?: IpdDischargeClearanceRow | null;
  activeMedicationLines?: {
    id: string;
    medicineName: string;
    dose: string;
    route: string;
    frequency: string;
  }[];
  medRecCompleted?: boolean;
  className?: string;
}

export function DischargeTab({
  admissionId,
  status,
  canDischarge = true,
  dischargeReadyAt,
  onToggleDischargeReady,
  doctorName,
  patientName,
  mrn,
  ipdNumber,
  bedLabel,
  wardName,
  dischargeMedicationsCount = 0,
  dischargeSummary,
  homeMedications,
  attendingDoctor,
  initialClearance,
  activeMedicationLines = [],
  medRecCompleted = false,
  className = '',
}: DischargeTabProps) {
  const [currentStatus, setCurrentStatus] = useState(status);
  const [clearance, setClearance] = useState<Partial<IpdDischargeClearanceRow>>(
    initialClearance || {
      dischargeType: 'regular',
      clinicalFitAt: status === 'discharge_ready' ? new Date() : null,
      pharmacyReturnedAt: null,
      pharmacyReturnItems: [],
      nursingClearedAt: null,
      ivCannulaRemoved: false,
      foleyCatheterRemoved: false,
      belongingsAndReportsHandedOver: false,
      dischargeVitalsTaken: false,
      billingClearedAt: null,
      gatePassNumber: null,
    },
  );

  const [isUpdating, setIsUpdating] = useState(false);
  const [feedbackMessage, setFeedbackMessage] = useState<string | null>(null);

  // Modal / Drawer visibility states
  const [isMedicalModalOpen, setIsMedicalModalOpen] = useState(false);
  const [isPharmacyDrawerOpen, setIsPharmacyDrawerOpen] = useState(false);
  const [isSummaryDrawerOpen, setIsSummaryDrawerOpen] = useState(false);
  const [isGatePassModalOpen, setIsGatePassModalOpen] = useState(false);

  const isReady = currentStatus === 'discharge_ready' || Boolean(clearance.clinicalFitAt);
  const isDischarged = currentStatus === 'discharged' || Boolean(clearance.gatePassNumber);

  // Compute live multi-department clearance gate
  const clearanceStatus = computeClearanceStatus({
    clearance,
    isSummaryFinalized: dischargeSummary?.status === 'finalized',
    isBillingSettled: Boolean(clearance.billingClearedAt),
  });

  // Handler: Medical Fit-to-Leave
  const handleMedicalSave = async (data: {
    dischargeType: 'regular' | 'lama' | 'dama' | 'transfer' | 'absconded' | 'death';
    clinicalStabilityNotes: string;
    ready: boolean;
  }) => {
    setIsUpdating(true);
    setFeedbackMessage(null);
    try {
      const res = await updateMedicalClearanceAction({
        admissionId,
        dischargeType: data.dischargeType,
        clinicalStabilityNotes: data.clinicalStabilityNotes,
        ready: data.ready,
      });
      if (!res.ok) throw new Error(res.error);

      if (onToggleDischargeReady) {
        await onToggleDischargeReady(data.ready);
      }

      setClearance((prev) => ({
        ...prev,
        dischargeType: data.dischargeType,
        clinicalStabilityNotes: data.clinicalStabilityNotes,
        clinicalFitAt: data.ready ? new Date() : null,
      }));
      setCurrentStatus(data.ready ? 'discharge_ready' : 'admitted');
      setFeedbackMessage(
        data.ready
          ? 'Medical clearance certified. Patient is fit for discharge.'
          : 'Medical clearance revoked. Patient returned to admitted status.',
      );
    } catch (err: any) {
      setFeedbackMessage(err?.message || 'Failed to update medical clearance.');
    } finally {
      setIsUpdating(false);
    }
  };

  // Handler: Quick toggle medical ready
  const handleQuickToggle = async (newReady: boolean) => {
    await handleMedicalSave({
      dischargeType: (clearance.dischargeType as any) || 'regular',
      clinicalStabilityNotes: clearance.clinicalStabilityNotes || '',
      ready: newReady,
    });
  };

  // Handler: Pharmacy Returns & Dispensing
  const handlePharmacySave = async (data: {
    returnItems: PharmacyReturnItem[];
    creditNoteNo: string;
    creditAmountPaise: number;
    takeHomeCounseled: boolean;
    takeHomeCounselingNotes: string;
    cleared: boolean;
  }) => {
    const res = await recordPharmacyClearanceAction({
      admissionId,
      returnItems: data.returnItems,
      creditNoteNo: data.creditNoteNo,
      creditAmountPaise: data.creditAmountPaise,
      takeHomeCounseled: data.takeHomeCounseled,
      takeHomeCounselingNotes: data.takeHomeCounselingNotes,
      cleared: data.cleared,
    });
    if (!res.ok) throw new Error(res.error);

    setClearance((prev) => ({
      ...prev,
      pharmacyReturnItems: data.returnItems,
      pharmacyCreditNoteNo: data.creditNoteNo || null,
      pharmacyCreditAmountPaise: data.creditAmountPaise,
      takeHomeCounseled: data.takeHomeCounseled,
      takeHomeCounselingNotes: data.takeHomeCounselingNotes || null,
      pharmacyReturnedAt: data.cleared ? new Date() : null,
    }));
    setFeedbackMessage(
      data.cleared
        ? 'Pharmacy clearance recorded with bedside return slip.'
        : 'Pharmacy returns draft saved.',
    );
  };

  // Handler: Nursing Handover & Line Removal
  const handleNursingUpdate = async (data: {
    ivCannulaRemoved: boolean;
    foleyCatheterRemoved: boolean;
    drainsRemoved: boolean;
    woundDressingDone: boolean;
    belongingsAndReportsHandedOver: boolean;
    dischargeVitalsTaken: boolean;
    nursingHandoverNotes?: string;
    cleared: boolean;
  }) => {
    const res = await updateNursingClearanceAction({
      admissionId,
      ivCannulaRemoved: data.ivCannulaRemoved,
      foleyCatheterRemoved: data.foleyCatheterRemoved,
      drainsRemoved: data.drainsRemoved,
      woundDressingDone: data.woundDressingDone,
      belongingsAndReportsHandedOver: data.belongingsAndReportsHandedOver,
      dischargeVitalsTaken: data.dischargeVitalsTaken,
      nursingHandoverNotes: data.nursingHandoverNotes,
      cleared: data.cleared,
    });
    if (!res.ok) throw new Error(res.error);

    setClearance((prev) => ({
      ...prev,
      ivCannulaRemoved: data.ivCannulaRemoved,
      foleyCatheterRemoved: data.foleyCatheterRemoved,
      drainsRemoved: data.drainsRemoved,
      woundDressingDone: data.woundDressingDone,
      belongingsAndReportsHandedOver: data.belongingsAndReportsHandedOver,
      dischargeVitalsTaken: data.dischargeVitalsTaken,
      nursingHandoverNotes: data.nursingHandoverNotes || null,
      nursingClearedAt: data.cleared ? new Date() : null,
    }));
    setFeedbackMessage(
      data.cleared
        ? 'Nursing handover & line removal checklist cleared.'
        : 'Nursing handover checklist saved.',
    );
  };

  // Handler: Issue Gate Pass
  const handleIssueGatePass = async () => {
    const res = await issueDischargeGatePassAction({ admissionId });
    if (!res.ok) throw new Error(res.error);

    setClearance((prev) => ({
      ...prev,
      gatePassNumber: res.data?.gatePassNumber,
      gatePassIssuedAt: res.data?.issuedAt,
      billingClearedAt: prev.billingClearedAt || new Date(),
    }));
    setCurrentStatus('discharged');
    setFeedbackMessage(`Discharge Gate Pass ${res.data?.gatePassNumber} issued successfully.`);
  };

  const progressPercent = Math.round((clearanceStatus.completedCount / 5) * 100);

  return (
    <div className={`space-y-4 ${className}`}>
      {/* Cockpit Header with Real-Time Progress Bar */}
      <div className="bg-surface p-4 rounded-xl border border-ink-200/80 shadow-2xs space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-bold text-ink-950">Discharge Clearance Cockpit</h2>
              <span className="text-2xs font-bold px-2 py-0.5 rounded bg-brand-100 text-brand-800">
                Discharge Workflow
              </span>
              <span className="text-2xs font-semibold px-2 py-0.5 rounded bg-ink-100 text-ink-700">
                NABH 5-Pillar Clearance
              </span>
            </div>
            <p className="text-xs text-ink-500 mt-0.5">
              Coordinate medical clearance, audit unconsumed pharmacy returns, confirm nursing line removals, and issue final exit Gate Pass.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsGatePassModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded border border-ink-200 text-ink-800 bg-surface hover:bg-ink-50 shadow-2xs"
            >
              <PrinterIcon className="size-3.5" />
              <span>{clearance.gatePassNumber ? 'Print Exit Gate Pass' : 'Gate Pass Checkpoint'}</span>
            </button>
          </div>
        </div>

        {/* Progress Bar Strip */}
        <div className="pt-2 border-t border-ink-100 space-y-1.5">
          <div className="flex items-center justify-between text-2xs">
            <span className="font-semibold text-ink-700">
              Clearance Progress: <strong className="text-ink-950">{clearanceStatus.completedCount} of 5 Departments Cleared</strong> ({progressPercent}%)
            </span>
            <span className={`font-bold ${clearanceStatus.canIssueGatePass ? 'text-emerald-700' : 'text-amber-700'}`}>
              {clearanceStatus.canIssueGatePass ? 'Ready for Exit Gate Pass ✓' : 'Clearances in Progress'}
            </span>
          </div>
          <div className="w-full h-2 rounded-full bg-ink-100 overflow-hidden">
            <div
              className={`h-full transition-all duration-300 rounded-full ${
                progressPercent === 100 ? 'bg-emerald-600' : 'bg-primary'
              }`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>
      </div>

      {feedbackMessage && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs rounded-xl font-medium animate-in fade-in">
          {feedbackMessage}
        </div>
      )}

      {/* 5-Card Multi-Department Clearance Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Step 1: Medical Clearance */}
        <MedicalClearanceCard
          doctorName={doctorName}
          isReady={isReady}
          isDischarged={isDischarged}
          dischargeType={clearance.dischargeType}
          clinicalFitAt={clearance.clinicalFitAt}
          clinicalStabilityNotes={clearance.clinicalStabilityNotes}
          canDischarge={canDischarge}
          isUpdating={isUpdating}
          onOpenModal={() => setIsMedicalModalOpen(true)}
          onQuickToggle={handleQuickToggle}
        />

        {/* Step 2: Pharmacy Clearance & Returns */}
        <PharmacyClearanceCard
          admissionId={admissionId}
          isCleared={Boolean(clearance.pharmacyReturnedAt)}
          pharmacyReturnedAt={clearance.pharmacyReturnedAt}
          pharmacyCreditNoteNo={clearance.pharmacyCreditNoteNo}
          pharmacyCreditAmountPaise={clearance.pharmacyCreditAmountPaise ?? 0}
          returnItems={clearance.pharmacyReturnItems as any}
          takeHomeCount={dischargeSummary?.takeHomePrescriptions?.length ?? dischargeMedicationsCount}
          takeHomeCounseled={clearance.takeHomeCounseled}
          medRecCompleted={medRecCompleted}
          onOpenDrawer={() => setIsPharmacyDrawerOpen(true)}
        />

        {/* Step 3: Nursing & Bedside Handover */}
        <NursingClearanceCard
          isCleared={Boolean(clearance.nursingClearedAt)}
          nursingClearedAt={clearance.nursingClearedAt}
          ivCannulaRemoved={clearance.ivCannulaRemoved}
          foleyCatheterRemoved={clearance.foleyCatheterRemoved}
          drainsRemoved={clearance.drainsRemoved}
          woundDressingDone={clearance.woundDressingDone}
          belongingsAndReportsHandedOver={clearance.belongingsAndReportsHandedOver}
          dischargeVitalsTaken={clearance.dischargeVitalsTaken}
          nursingHandoverNotes={clearance.nursingHandoverNotes}
          onUpdate={handleNursingUpdate}
        />

        {/* Step 4: Discharge Summary & Documentation */}
        <SummaryClearanceCard
          admissionId={admissionId}
          dischargeSummary={dischargeSummary}
          takeHomeMedsCount={dischargeMedicationsCount}
          onOpenSummaryDrawer={() => setIsSummaryDrawerOpen(true)}
        />

        {/* Step 5: Billing Settlement & Gate Pass */}
        <BillingGatePassCard
          admissionId={admissionId}
          isSettled={Boolean(clearance.billingClearedAt)}
          gatePassNumber={clearance.gatePassNumber}
          gatePassIssuedAt={clearance.gatePassIssuedAt}
          canIssueGatePass={clearanceStatus.canIssueGatePass}
          onOpenGatePassModal={() => setIsGatePassModalOpen(true)}
        />
      </div>

      {/* Drawers and Modals */}
      <MedicalClearanceModal
        isOpen={isMedicalModalOpen}
        onClose={() => setIsMedicalModalOpen(false)}
        admissionId={admissionId}
        patientName={patientName}
        doctorName={doctorName}
        initialDischargeType={(clearance.dischargeType as any) || 'regular'}
        initialNotes={clearance.clinicalStabilityNotes}
        isReady={isReady}
        onSave={handleMedicalSave}
      />

      <PharmacyReturnDrawer
        isOpen={isPharmacyDrawerOpen}
        onClose={() => setIsPharmacyDrawerOpen(false)}
        admissionId={admissionId}
        patientName={patientName}
        initialItems={clearance.pharmacyReturnItems as any}
        activeOrders={activeMedicationLines}
        initialCreditNoteNo={clearance.pharmacyCreditNoteNo}
        initialCreditAmountPaise={clearance.pharmacyCreditAmountPaise ?? 0}
        initialCounseled={clearance.takeHomeCounseled}
        initialCounselingNotes={clearance.takeHomeCounselingNotes}
        onSave={handlePharmacySave}
      />

      <GatePassModal
        isOpen={isGatePassModalOpen}
        onClose={() => setIsGatePassModalOpen(false)}
        admissionId={admissionId}
        patientName={patientName}
        mrn={mrn}
        ipdNumber={ipdNumber}
        bedLabel={bedLabel}
        wardName={wardName}
        doctorName={doctorName}
        gatePassNumber={clearance.gatePassNumber}
        issuedAt={clearance.gatePassIssuedAt}
        clearanceStatus={clearanceStatus}
        onIssue={handleIssueGatePass}
      />

      <DischargeSummaryDrawer
        admissionId={admissionId}
        isOpen={isSummaryDrawerOpen}
        onClose={() => setIsSummaryDrawerOpen(false)}
        patientName={patientName ?? 'Patient'}
        initialSummary={dischargeSummary}
        homeMedications={homeMedications}
        attendingDoctor={attendingDoctor}
      />
    </div>
  );
}
