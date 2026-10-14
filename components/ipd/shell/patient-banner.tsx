'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { formatDoctor, toTitleCase } from '@/lib/domain/doctor';
import { StatusBadge } from '@/components/ipd/status-badge';
import { Drawer } from '@/components/ipd/drawer';
import { RecordMeasurementModal } from '@/components/ipd/measurements/record-measurement-modal';
import { PrinterIcon, FileTextIcon, ArrowLeftIcon } from '@/components/icons';
import type { BadgeColorKey } from '@/constants/clinical';

export interface PatientBannerData {
  name: string;
  age?: number | null;
  gender?: string | null;
  uhid: string;
  ipdNumber: number | string;
  wardName?: string | null;
  bedLabel?: string | null;
  dayOfStay?: number | null;
  doctorName?: string | null;
  diagnosis?: string | null;
  allergyStatus?: 'unreviewed' | 'allergies_documented' | 'nkda' | null;
  allergies?: string[] | null;
  weightKg?: number | null;
  heightCm?: number | null;
  bmi?: number | null;
  status: string;
}

export interface PatientBannerProps {
  admissionId: string;
  patient: PatientBannerData;
  className?: string;
}

function resolveStatusVariant(status: string): BadgeColorKey {
  const s = status.toLowerCase();
  if (s.includes('ready')) return 'green';
  if (s.includes('planned')) return 'amber';
  if (s.includes('admitted')) return 'blue';
  if (s.includes('discharged')) return 'grey';
  return 'neutral';
}

export function PatientBanner({
  admissionId,
  patient,
  className = '',
}: PatientBannerProps) {
  const [isAllergyDrawerOpen, setIsAllergyDrawerOpen] = useState(false);
  const [isDiagnosisDrawerOpen, setIsDiagnosisDrawerOpen] = useState(false);
  const [isHistoryDrawerOpen, setIsHistoryDrawerOpen] = useState(false);
  const [isMeasurementModalOpen, setIsMeasurementModalOpen] = useState(false);

  const formattedName = toTitleCase(patient.name);
  const formattedDoctor = formatDoctor(patient.doctorName);
  const statusVariant = resolveStatusVariant(patient.status);

  const bedString = [
    patient.wardName,
    patient.bedLabel ? `Bed ${patient.bedLabel}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const ageGenderString = [
    patient.age != null ? `${patient.age} yrs` : null,
    patient.gender,
  ]
    .filter(Boolean)
    .join(' · ');

  // Allergy Chip logic:
  // - Allergies: <list> (red)
  // - No known allergies (grey)
  // - Allergies not recorded (amber, clickable)
  const hasDocumentedAllergies =
    patient.allergyStatus === 'allergies_documented' &&
    Array.isArray(patient.allergies) &&
    patient.allergies.length > 0;

  const isNkda =
    patient.allergyStatus === 'nkda' ||
    (patient.allergyStatus === 'allergies_documented' &&
      (!patient.allergies || patient.allergies.length === 0));

  const isAllergiesUnrecorded =
    !patient.allergyStatus || patient.allergyStatus === 'unreviewed';

  const patientDrawerContext = {
    name: formattedName,
    uhid: patient.uhid,
    bedLabel: patient.bedLabel ? `Bed ${patient.bedLabel}` : null,
  };

  return (
    <>
      <section
        aria-label="Patient Banner"
        className={`sticky top-0 z-30 bg-surface border-b border-ink-100 shadow-xs px-3.5 py-1.5 sm:px-5 ${className}`}
      >
        <div className="flex flex-col gap-1.5 lg:flex-row lg:items-center lg:justify-between">
          {/* Main demographics block */}
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
            {/* Back to Patients Navigation */}
            <Link
              href="/ipd/my-patients"
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-ink-700 bg-surface rounded border border-ink-200 hover:bg-ink-100 hover:text-ink-950 transition-colors shadow-2xs mr-1"
              aria-label="Back to Patients"
              title="Back to patient list"
            >
              <ArrowLeftIcon className="size-3.5 text-ink-500" />
              <span>Back</span>
            </Link>

            {/* Patient Name */}
            <h1 className="text-sm font-semibold text-ink-950 tracking-tight">
              {formattedName}
            </h1>

            {/* Age / Gender */}
            {ageGenderString && (
              <span className="text-ink-600 text-xs font-normal">
                {ageGenderString}
              </span>
            )}

            <span className="text-ink-300 hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* UHID */}
            <span className="font-semibold text-ink-700 text-xs tracking-wide">
              {patient.uhid}
            </span>

            {/* IPD # */}
            <span className="text-ink-500 text-xs">
              {`IPD #${patient.ipdNumber}`}
            </span>

            <span className="text-ink-300 hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* Ward · Bed */}
            {bedString && (
              <span className="font-semibold text-ink-800 text-xs">
                {bedString}
              </span>
            )}

            {/* Day of Stay */}
            {patient.dayOfStay != null && (
              <span className="inline-flex items-center px-1.5 py-0.2 rounded text-[11px] font-semibold bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200">
                {`Day ${patient.dayOfStay}`}
              </span>
            )}

            <span className="text-ink-300 hidden sm:inline" aria-hidden="true">
              |
            </span>

            {/* Consultant */}
            <span className="text-xs text-ink-600">
              Consultant: <span className="font-semibold text-ink-800">{formattedDoctor}</span>
            </span>
          </div>

          {/* Clinical chips, status badge, action buttons */}
          <div className="flex flex-wrap items-center gap-1.5">
            {/* Diagnosis Chip */}
            {patient.diagnosis ? (
              <button
                type="button"
                onClick={() => setIsDiagnosisDrawerOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-normal bg-ink-50 text-ink-800 ring-1 ring-inset ring-ink-200 hover:bg-ink-100 min-h-[26px]"
                title="Click to view/edit diagnosis"
              >
                <span className="font-semibold text-ink-600 mr-1">Dx:</span>
                <span className="truncate max-w-[180px]">{patient.diagnosis}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsDiagnosisDrawerOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100 min-h-[26px]"
                title="Diagnosis not recorded. Click to enter diagnosis."
              >
                Diagnosis not recorded
              </button>
            )}

            {/* Allergy Chip */}
            {hasDocumentedAllergies && (
              <button
                type="button"
                onClick={() => setIsAllergyDrawerOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-50 text-rose-900 ring-1 ring-inset ring-rose-300 hover:bg-rose-100 min-h-[26px]"
                title="Click to review allergies"
              >
                {`Allergies: ${patient.allergies!.join(', ')}`}
              </button>
            )}

            {isNkda && (
              <button
                type="button"
                onClick={() => setIsAllergyDrawerOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-ink-100 text-ink-600 ring-1 ring-inset ring-ink-200 hover:bg-ink-200 min-h-[26px]"
                title="No known drug allergies. Click to review."
              >
                No known allergies
              </button>
            )}

            {isAllergiesUnrecorded && (
              <button
                type="button"
                onClick={() => setIsAllergyDrawerOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100 min-h-[26px]"
                title="Allergies not recorded. Click to assess allergies."
              >
                Allergies not recorded
              </button>
            )}

            {/* Measurement Chip (Weight, Height, BMI) */}
            {patient.weightKg != null ? (
              <button
                type="button"
                onClick={() => setIsMeasurementModalOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-normal bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-300 hover:bg-sky-100 min-h-[26px]"
                title="Click to view/update patient weight and height"
              >
                <span className="font-semibold text-sky-700 mr-1">Wt:</span>
                <span>{`${patient.weightKg} kg`}</span>
                {patient.heightCm != null && (
                  <>
                    <span className="mx-1 text-sky-300">·</span>
                    <span className="font-semibold text-sky-700 mr-1">Ht:</span>
                    <span>{`${patient.heightCm} cm`}</span>
                  </>
                )}
                {patient.bmi != null && (
                  <>
                    <span className="mx-1 text-sky-300">·</span>
                    <span className="font-semibold text-sky-700">{`BMI: ${patient.bmi}`}</span>
                  </>
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setIsMeasurementModalOpen(true)}
                className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-900 ring-1 ring-inset ring-amber-300 hover:bg-amber-100 min-h-[26px]"
                title="Patient weight and height not recorded. Click to enter."
              >
                Weight: Not recorded
              </button>
            )}

            {/* Status Badge */}
            <StatusBadge status={patient.status} variant={statusVariant} />

            {/* History Action */}
            <button
              type="button"
              onClick={() => setIsHistoryDrawerOpen(true)}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-ink-700 bg-surface rounded border border-ink-200 hover:bg-ink-50 focus:outline-none focus:ring-1 focus:ring-primary min-h-[28px]"
              aria-label="View admission history"
            >
              <FileTextIcon className="h-3 w-3" />
              <span>History</span>
            </button>

            {/* Print File Action */}
            <button
              type="button"
              onClick={() => {
                if (typeof window !== 'undefined') {
                  window.print();
                }
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold text-ink-700 bg-surface rounded border border-ink-200 hover:bg-ink-50 focus:outline-none focus:ring-1 focus:ring-primary min-h-[28px]"
              aria-label="Print patient file"
            >
              <PrinterIcon className="h-3 w-3" />
              <span>Print file</span>
            </button>
          </div>
        </div>
      </section>

      {/* Allergy Drawer */}
      <Drawer
        isOpen={isAllergyDrawerOpen}
        onClose={() => setIsAllergyDrawerOpen(false)}
        title="Drug Allergies"
        patient={patientDrawerContext}
        footer={
          <button
            type="button"
            onClick={() => setIsAllergyDrawerOpen(false)}
            className="px-4 py-2 text-xs font-semibold rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
          >
            Close
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-ink-600">
            Documented patient drug and substance allergies for admission{' '}
            <span className="font-semibold">{admissionId}</span>.
          </p>
          {patient.allergies && patient.allergies.length > 0 ? (
            <ul className="divide-y divide-ink-100 rounded-md border border-ink-200 bg-surface">
              {patient.allergies.map((allergy, idx) => (
                <li key={idx} className="px-3 py-2 text-xs font-semibold text-rose-800">
                  {allergy}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-ink-500 italic">
              {patient.allergyStatus === 'nkda'
                ? 'Confirmed: No known drug allergies (NKDA).'
                : 'Allergies have not been documented for this patient.'}
            </p>
          )}
        </div>
      </Drawer>

      {/* Diagnosis Drawer */}
      <Drawer
        isOpen={isDiagnosisDrawerOpen}
        onClose={() => setIsDiagnosisDrawerOpen(false)}
        title="Admission Diagnosis"
        patient={patientDrawerContext}
        footer={
          <button
            type="button"
            onClick={() => setIsDiagnosisDrawerOpen(false)}
            className="px-4 py-2 text-xs font-semibold rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
          >
            Close
          </button>
        }
      >
        <div className="space-y-4">
          <p className="text-xs text-ink-600">
            Primary working diagnosis and admission impressions.
          </p>
          <div className="p-3 bg-ink-50 rounded-md text-xs text-ink-800 font-semibold border border-ink-200">
            {patient.diagnosis || 'No working diagnosis recorded.'}
          </div>
        </div>
      </Drawer>

      {/* History Drawer */}
      <Drawer
        isOpen={isHistoryDrawerOpen}
        onClose={() => setIsHistoryDrawerOpen(false)}
        title="Admission History"
        patient={patientDrawerContext}
        footer={
          <button
            type="button"
            onClick={() => setIsHistoryDrawerOpen(false)}
            className="px-4 py-2 text-xs font-semibold rounded-md border border-ink-200 text-ink-700 hover:bg-ink-50 min-h-[44px]"
          >
            Close
          </button>
        }
      >
        <div className="space-y-4 text-xs text-ink-700">
          <p>
            Admission timeline for <span className="font-semibold">{formattedName}</span> (IPD #{patient.ipdNumber}).
          </p>
          <div className="rounded-md border border-ink-200 p-3 bg-surface space-y-1.5">
            <div className="font-semibold text-ink-800">Current Stay: Day {patient.dayOfStay ?? 1}</div>
            <div className="text-ink-600">Ward: {bedString || 'Unassigned'}</div>
            <div className="text-ink-600">Admitting Consultant: {formattedDoctor}</div>
            <div className="text-ink-600">Current Status: {patient.status}</div>
          </div>
        </div>
      </Drawer>

      {/* Record Measurement Modal */}
      <RecordMeasurementModal
        admissionId={admissionId}
        isOpen={isMeasurementModalOpen}
        onClose={() => setIsMeasurementModalOpen(false)}
        currentWeightKg={patient.weightKg}
        currentHeightCm={patient.heightCm}
        patientName={formattedName}
      />
    </>
  );
}
